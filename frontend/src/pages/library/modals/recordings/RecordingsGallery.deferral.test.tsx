import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecordingAnalysisProgress } from '../../../../contracts/clients';
import type { RecordingDto, SongDto } from '../../../../contracts/models';
import '../../../../providers/localization';
import { RecordingsModal } from './index';

const source = vi.hoisted(() => ({
  recordings: [] as RecordingDto[],
  progress: {} as Record<string, RecordingAnalysisProgress>,
  failures: {} as Record<string, string>,
  rename: vi.fn(async () => true),
  mounts: new Map<string, number>(),
  unmounts: new Map<string, number>(),
  latestAnalysis: vi.fn(async () => null),
}));

vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => () => undefined,
}));
vi.mock('../../../../services/pythonClient', () => ({
  pythonClient: { latestAnalysis: source.latestAnalysis },
}));
vi.mock('./useSongRecordings', () => ({
  useSongRecordings: () => ({
    song,
    recordings: source.recordings,
    loadingRecordings: false,
    failedRecordings: false,
    reloadRecordings() {},
    close() {},
    analyze() {},
    remove() {},
    rename: source.rename,
    analysisProgress: source.progress,
    analysisFailures: source.failures,
    cancelAnalysis() {},
    analysisRecordId: null,
  }),
}));
// The real card, query observer and UI-kit controls are used. This stateful player
// makes any unintended unmount visible without requiring an audio device.
vi.mock('./RecordingPlayer', () => ({
  RecordingPlayer: ({ recording }: { recording: RecordingDto }) => {
    const [position, setPosition] = useState(0);
    const [volume, setVolume] = useState(1);
    const [playing, setPlaying] = useState(false);
    useEffect(() => {
      source.mounts.set(
        recording.id,
        (source.mounts.get(recording.id) ?? 0) + 1,
      );
      return () => {
        source.unmounts.set(
          recording.id,
          (source.unmounts.get(recording.id) ?? 0) + 1,
        );
      };
    }, [recording.id]);
    return (
      <div className="recordingPlayer" data-recording={recording.id}>
        <button
          aria-label="Playback"
          aria-pressed={playing}
          onClick={() => setPlaying(!playing)}
        >
          Play
        </button>
        <input
          aria-label="Position"
          type="range"
          min="0"
          max="240"
          value={position}
          onChange={(event) => setPosition(Number(event.target.value))}
        />
        <input
          aria-label="Volume"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(event) => setVolume(Number(event.target.value))}
        />
      </div>
    );
  },
}));

class Observer {
  static instances: Observer[] = [];
  observed = new Set<Element>();
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    Observer.instances.push(this);
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
}

const song: SongDto = {
  id: 'song',
  title: 'Performance archive',
  artist: 'Singer',
  language: 'Auto',
  status: 'ready',
  durationSeconds: 240,
  createdAt: '2026-11-20T00:00:00Z',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
};

const take = (index: number): RecordingDto => ({
  id: `take-${index}`,
  songId: song.id,
  filePath: `/recordings/take-${index}.wav`,
  displayName: `Performance ${index + 1}`,
  createdAt: '2026-11-20T00:00:00Z',
  durationSeconds: 240,
  sizeBytes: 100,
  fileStatus: 'Ready',
  analysisStatus: 'NotAnalyzed',
  analyzed: false,
});

let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', Observer);
  Observer.instances = [];
  source.recordings = Array.from({ length: 500 }, (_, index) => take(index));
  source.progress = {};
  source.failures = {};
  source.mounts.clear();
  source.unmounts.clear();
  vi.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

const mount = () =>
  render(
    <QueryClientProvider client={client}>
      <RecordingsModal
        requestedSong={null}
        onRequestHandled={() => undefined}
        onAnalysisReady={() => undefined}
      />
    </QueryClientProvider>,
  );
const rerender = (view: ReturnType<typeof mount>) =>
  view.rerender(
    <QueryClientProvider client={client}>
      <RecordingsModal
        requestedSong={null}
        onRequestHandled={() => undefined}
        onAnalysisReady={() => undefined}
      />
    </QueryClientProvider>,
  );
const grid = () => {
  fireEvent.click(screen.getByRole('tab', { name: tr('recordingsGridView') }));
  return document.querySelector<HTMLUListElement>('.recordingsList')!;
};
const observers = () =>
  client
    .getQueryCache()
    .getAll()
    .reduce((sum, query) => sum + query.getObserversCount(), 0);
const near = (target: Element, isIntersecting = true) => {
  act(() => {
    for (const observer of Observer.instances.filter(
      (item) => item.options?.rootMargin === '200px',
    )) {
      observer.callback(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
    }
  });
};

it('defers card bodies and queries in a 500-take gallery while preserving every list item', () => {
  mount();
  const list = grid();
  expect(list.children).toHaveLength(500);
  // The already opened featured take may stay mounted when the view changes.
  expect(list.querySelectorAll('.recordingCard').length).toBeLessThanOrEqual(1);
  expect(list.querySelectorAll('.ad-border').length).toBeLessThanOrEqual(1);
  expect(observers()).toBeLessThanOrEqual(1);
  expect(list.querySelectorAll('*').length).toBeLessThan(6_000);
  expect(source.latestAnalysis).not.toHaveBeenCalled();
});

it('activates only near cards, keeps their outer list items and releases observation on cleanup', () => {
  const view = mount();
  const list = grid();
  const first = list.children[220]!;
  const second = list.children[350]!;
  const before = observers();
  expect(first.querySelector('.recordingCard')).toBeNull();
  near(first);
  expect(first.querySelector('.recordingCard')).not.toBeNull();
  expect(list.children[220]).toBe(first);
  expect(second.querySelector('.recordingCard')).toBeNull();
  expect(observers()).toBe(before + 1);
  near(second);
  expect(observers()).toBe(before + 2);
  near(first, false);
  expect(first.querySelector('.recordingCard')).not.toBeNull();
  view.unmount();
  expect(
    Observer.instances
      .filter((item) => item.options?.rootMargin === '200px')
      .every((item) => item.observed.size === 0),
  ).toBe(true);
});

it('keeps version, rename draft, paused transport and active playback after cards leave the viewport', () => {
  const original = source.recordings[220]!;
  source.recordings.push({
    ...original,
    id: 'master',
    sourceRecordingId: original.id,
  });
  mount();
  const list = grid();
  const card = list.children[220] as HTMLElement;
  near(card);
  fireEvent.click(
    within(card).getByRole('tab', { name: tr('studioMasterTitle') }),
  );
  const player = card.querySelector('[data-recording="master"]');
  expect(player).not.toBeNull();
  fireEvent.change(within(card).getByRole('slider', { name: 'Position' }), {
    target: { value: '87' },
  });
  fireEvent.change(within(card).getByRole('slider', { name: 'Volume' }), {
    target: { value: '0.37' },
  });
  fireEvent.click(within(card).getByRole('button', { name: tr('renameTake') }));
  fireEvent.change(
    within(card).getByRole('textbox', { name: tr('renameTake') }),
    { target: { value: 'Unfinished rename' } },
  );
  near(card, false);
  fireEvent.scroll(list, { target: { scrollTop: 30_000 } });
  expect(card.querySelector('[data-recording="master"]')).toBe(player);
  expect(within(card).getByRole('slider', { name: 'Position' })).toHaveValue(
    '87',
  );
  expect(within(card).getByRole('slider', { name: 'Volume' })).toHaveValue(
    '0.37',
  );
  expect(
    within(card).getByRole('textbox', { name: tr('renameTake') }),
  ).toHaveValue('Unfinished rename');
  expect(
    within(card).getByRole('button', { name: 'Playback' }),
  ).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(within(card).getByRole('button', { name: 'Playback' }));
  near(card, true);
  near(card, false);
  expect(
    within(card).getByRole('button', { name: 'Playback' }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(source.mounts.get('master')).toBe(1);
  expect(source.unmounts.get('master')).toBeUndefined();
});

it.each([false, true])(
  'forwards %s reverse Tab entry into the correct end of the activated card',
  (reverse) => {
    mount();
    const list = grid();
    const target = list.children[220] as HTMLElement;
    const neighbour = list.children[reverse ? 221 : 219] as HTMLElement;
    near(neighbour);
    const from = within(neighbour).getByRole('button', {
      name: reverse ? tr('renameTake') : tr('recordingDelete'),
    });
    expect(target.tabIndex).toBe(0);
    act(() => {
      from.focus();
    });
    fireEvent.keyDown(from, { key: 'Tab', shiftKey: reverse });
    // jsdom does not implement native Tab navigation; focus the browser's next stop.
    act(() => {
      target.focus();
    });
    expect(
      within(target).getByRole('button', {
        name: reverse ? tr('recordingDelete') : tr('renameTake'),
      }),
    ).toHaveFocus();
    expect(target.tabIndex).toBe(-1);
    expect(target.querySelector('.recordingCardPlaceholder')).toBeNull();
  },
);

it('does not steal focus when near activation or a later focus target wins the race', () => {
  mount();
  const list = grid();
  const first = list.children[220] as HTMLElement;
  const second = list.children[221] as HTMLElement;
  const anchor = screen.getByRole('tab', { name: tr('recordingsGridView') });
  act(() => {
    anchor.focus();
  });
  near(first);
  expect(anchor).toHaveFocus();
  act(() => {
    second.focus();
    anchor.focus();
  });
  expect(second.querySelector('.recordingCard')).not.toBeNull();
  expect(anchor).toHaveFocus();
});

it('reserves the player and optional version, progress and wrapped failure rows before activation', () => {
  const original = source.recordings[220]!;
  source.recordings.push({
    ...original,
    id: 'master',
    sourceRecordingId: original.id,
  });
  source.progress[original.id] = {
    recordingId: original.id,
    jobId: 'job',
    state: 'Running',
    stage: 'Loading',
    progress: 34,
  };
  source.failures[original.id] =
    'A long failure description that must keep its natural wrapping at narrow card widths.';
  mount();
  const list = grid();
  const placeholder = list.children[220]!.querySelector(
    '.recordingCardPlaceholder',
  )!;
  expect(placeholder).not.toBeNull();
  expect(placeholder.querySelector('.recordingPlayerPending')).not.toBeNull();
  expect(
    placeholder.querySelector('[data-placeholder="versions"]'),
  ).not.toBeNull();
  expect(
    placeholder.querySelector('[data-placeholder="progress"]'),
  ).not.toBeNull();
  expect(
    placeholder.querySelector('[data-placeholder="failure"]'),
  ).toHaveTextContent(source.failures[original.id]!);
  expect(placeholder).toHaveAttribute('aria-hidden', 'true');
  expect(placeholder.querySelectorAll('button,svg,canvas,img')).toHaveLength(0);
});

it('keeps focused view and small galleries eager, and falls back eagerly without IntersectionObserver', async () => {
  const view = mount();
  expect(
    document
      .querySelector('.recordingsFeatured')!
      .querySelectorAll('.recordingCard'),
  ).toHaveLength(1);
  expect(observers()).toBe(1);
  view.unmount();
  source.recordings = Array.from({ length: 40 }, (_, index) => take(index));
  const small = mount();
  expect(grid().querySelectorAll('.recordingCard')).toHaveLength(40);
  expect(observers()).toBe(40);
  small.unmount();
  vi.stubGlobal('IntersectionObserver', undefined);
  source.recordings = Array.from({ length: 41 }, (_, index) => take(index));
  source.recordings[20] = {
    ...source.recordings[20]!,
    analysisStatus: 'Succeeded',
    analyzed: true,
  };
  mount();
  expect(grid().querySelectorAll('.recordingCard')).toHaveLength(41);
  expect(observers()).toBe(41);
  await waitFor(() =>
    expect(source.latestAnalysis).toHaveBeenCalledExactlyOnceWith('take-20'),
  );
});

it('preserves the existing card through gallery threshold changes and focused view switches', () => {
  source.recordings = Array.from({ length: 41 }, (_, index) => take(index));
  const view = mount();
  const list = grid();
  const first = list.children[0] as HTMLElement;
  near(first);
  fireEvent.change(within(first).getByRole('slider', { name: 'Position' }), {
    target: { value: '37' },
  });
  fireEvent.click(
    within(first).getByRole('button', { name: tr('renameTake') }),
  );
  fireEvent.change(
    within(first).getByRole('textbox', { name: tr('renameTake') }),
    { target: { value: 'Keep this draft' } },
  );
  const input = within(first).getByRole('textbox', { name: tr('renameTake') });
  const player = first.querySelector('.recordingPlayer');

  source.recordings = source.recordings.slice(0, 40);
  rerender(view);
  expect(list.querySelectorAll('.recordingCard')).toHaveLength(40);
  source.recordings = [...source.recordings, take(40)];
  rerender(view);
  // Previously eager bodies remain mounted; only the newly added take is deferred.
  expect(list.querySelectorAll('.recordingCard')).toHaveLength(40);
  expect(
    list.children[40]!.querySelector('.recordingCardPlaceholder'),
  ).not.toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: tr('recordingsListView') }));
  expect(document.querySelector('.recordingsFeatured')!.children[0]).toBe(
    first,
  );
  grid();
  expect(within(first).getByRole('textbox', { name: tr('renameTake') })).toBe(
    input,
  );
  expect(input).toHaveValue('Keep this draft');
  expect(first.querySelector('.recordingPlayer')).toBe(player);
  expect(within(first).getByRole('slider', { name: 'Position' })).toHaveValue(
    '37',
  );
  expect(source.mounts.get('take-0')).toBe(1);
  expect(source.unmounts.get('take-0')).toBeUndefined();
});

it('reverse focus entry skips disabled trailing actions', () => {
  source.recordings = Array.from({ length: 41 }, (_, index) => take(index));
  source.recordings[20] = {
    ...source.recordings[20]!,
    fileStatus: 'Preparing',
  };
  mount();
  const list = grid();
  const target = list.children[20] as HTMLElement;
  const next = list.children[21] as HTMLElement;
  near(next);
  act(() => {
    within(next)
      .getByRole('button', { name: tr('renameTake') })
      .focus();
  });
  act(() => {
    target.focus();
  });
  expect(
    within(target).getByRole('button', { name: tr('recordingDelete') }),
  ).toBeDisabled();
  expect(
    within(target).getByRole('button', { name: tr('openFolder') }),
  ).toHaveFocus();
});

it('starts the analysis query only for an activated analysed take', async () => {
  source.recordings[220] = {
    ...source.recordings[220]!,
    analysisStatus: 'Succeeded',
    analyzed: true,
  };
  source.recordings[221] = {
    ...source.recordings[221]!,
    analysisStatus: 'Succeeded',
    analyzed: true,
  };
  mount();
  const list = grid();
  expect(source.latestAnalysis).not.toHaveBeenCalled();
  near(list.children[220]!);
  await waitFor(() =>
    expect(source.latestAnalysis).toHaveBeenCalledExactlyOnceWith('take-220'),
  );
  expect(list.children[221]!.querySelector('.recordingCard')).toBeNull();
  near(list.children[220]!, false);
  expect(source.latestAnalysis).toHaveBeenCalledOnce();
  near(list.children[221]!);
  await waitFor(() => expect(source.latestAnalysis).toHaveBeenCalledTimes(2));
  expect(source.latestAnalysis).toHaveBeenLastCalledWith('take-221');
});
