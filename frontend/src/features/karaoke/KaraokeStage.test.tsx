import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MelodyRollProps } from '@neo-ui-kit/react';
import type { EditorDocument } from '../../application/editor/editorModel';
import { KaraokeStage } from './KaraokeStage';
import { SceneBackdrop } from './SceneBackdrop';
import { desktopClient } from '../../services/desktopClient';
import { store } from '../../providers/store';

const probe = vi.hoisted(() => {
  const props: MelodyRollProps[] = [];
  return { props, mounts: 0, playing: false, hitNoteIds: new Set<string>() };
});
vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  MelodyRoll: (props: MelodyRollProps) => {
    probe.props.push(props);
    useEffect(() => {
      probe.mounts++;
    }, []);
    return <div data-testid="roll" />;
  },
}));
vi.mock('../../providers/store', () => ({
  store: {
    preferences: {
      reducedMotion: false,
      headingFont: 'default',
      karaokeLyricsLayout: 'classic',
      karaokeLyricsLines: 2,
    },
    online: { room: null },
  },
}));
vi.mock('./useSmoothPosition', () => ({
  useSmoothPosition: (position: number) => position,
}));
vi.mock('./usePianoRollLayout', () => ({
  usePianoRollLayout: () => ({ layout: null, active: false }),
}));
vi.mock('../../shared/ui/useDetachedPanel', () => ({
  useDetachedPanel: () => ({ detached: false }),
}));
vi.mock('../../shared/ui/DetachedPanel', () => ({
  DetachedPanel: ({ children }: { children: ReactNode }) => children,
  DetachButton: () => null,
}));
vi.mock('./show/ShowLayers', () => {
  const engine = {
    get hitNoteIds() {
      return probe.hitNoteIds;
    },
    noteScore: undefined,
  };
  return {
    useShowEngine: () => engine,
    StageFx: () => null,
    RollFx: ({ playing }: { playing: boolean }) => {
      probe.playing = playing;
      return null;
    },
  };
});

const document: EditorDocument = {
  revision: 1,
  lyrics: 'one\ntwo\nthree\nfour',
  words: ['one', 'two', 'three', 'four'].map((text, index) => ({
    id: `w${index}`,
    text,
    start: 20 + index,
    end: 20.5 + index,
  })),
  notes: Array.from({ length: 4 }, (_, index) => ({
    id: `n${index}`,
    wordId: `w${index}`,
    pitch: 60,
    start: 20 + index,
    end: 20.5 + index,
  })),
};
const view = (position: number, source = document) => (
  <KaraokeStage
    songTitle="Song"
    document={source}
    position={position}
    playing
    rate={1}
    layers={{ showNotes: true, showLyrics: true }}
    vocalRange="auto"
  />
);
beforeEach(() => {
  Object.assign(store.preferences, {
    karaokeLyricsLayout: 'classic',
    karaokeLyricsLines: 2,
  });
  probe.props.length = 0;
  probe.mounts = 0;
  probe.hitNoteIds = new Set();
});
afterEach(() => vi.restoreAllMocks());

it('does not recheck every earlier hit on each unchanged animation frame', () => {
  probe.hitNoteIds = new Set(Array.from({ length: 2000 }, (_, i) => `n${i}`));
  const has = vi.spyOn(probe.hitNoteIds, 'has');
  const { rerender } = render(view(20.1));
  has.mockClear();
  for (let frame = 1; frame <= 60; frame++) rerender(view(20.1 + frame / 60));
  expect(has.mock.calls.length).toBe(0);
  probe.hitNoteIds = new Set([...probe.hitNoteIds, 'new-hit']);
  rerender(view(21.2));
  expect(probe.props.at(-1)?.hitIds?.has('new-hit')).toBe(true);
});

it('stops retrying failed song and fallback videos while allowing a new source', async () => {
  vi.spyOn(desktopClient, 'sceneVideoUrl').mockResolvedValue('fallback.mp4');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Electron's webview overload must not narrow this general DOM fixture.
  const dom: {
    createElement(tag: string, options?: ElementCreationOptions): HTMLElement;
  } = window.document;
  const createElement = dom.createElement.bind(dom);
  vi.spyOn(dom, 'createElement').mockImplementation((tag, options) => {
    const element = createElement(tag, options);
    if (tag === 'video')
      Object.assign(element, {
        load() {},
        getVideoPlaybackQuality: () => ({
          totalVideoFrames: 0,
          droppedVideoFrames: 0,
        }),
        requestVideoFrameCallback: () => 1,
        cancelVideoFrameCallback() {},
      });
    return element;
  });
  const backdrop = (videoUrl: string) => (
    <SceneBackdrop
      theme="dark"
      videoUrl={videoUrl}
      positionSeconds={0}
      playing={false}
      rate={1}
    />
  );
  const view = render(backdrop('song.mp4'));
  await act(async () => {});
  const own = view.container.querySelector('video');
  if (!own) throw new Error('Song video must be displayed');
  expect(own.getAttribute('src')).toBe('song.mp4');
  fireEvent.error(own);
  const fallback = view.container.querySelector('video');
  if (!fallback) throw new Error('Fallback video must be displayed');
  expect(fallback.getAttribute('src')).toBe('fallback.mp4');
  fireEvent.error(fallback);
  expect(view.container.querySelector('video')).toBeNull();
  view.rerender(backdrop('new-song.mp4'));
  expect(view.container.querySelector('video')?.getAttribute('src')).toBe(
    'new-song.mp4',
  );
});

it('shows both lyric lines at three, fitting their width without resizing during highlighting', () => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = computedStyle(element);
    style.fontSize =
      (element instanceof HTMLElement && element.style.fontSize) ||
      (element.closest('[data-layout="credits"]')
        ? '32px'
        : element.matches('.ad-lyrics-current')
          ? '64px'
          : '32px');
    return style;
  });
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(200);
  const measure = vi
    .spyOn(Element.prototype, 'scrollWidth', 'get')
    .mockImplementation(function (this: Element) {
      return this.closest('[data-layout="credits"]')
        ? 160
        : this.matches('.ad-lyrics-current')
          ? 400
          : 160;
    });
  const { rerender } = render(view(17.01));
  expect(screen.getByRole('timer')).toHaveTextContent('3');
  const current = screen.getByText('one');
  expect(screen.getByText('two')).toBeInTheDocument();
  const panel = current.closest('.lyricsPanel');
  expect(panel).not.toHaveAttribute('hidden');
  expect(panel).toHaveStyle({ opacity: '1' });
  const line = current.closest('.ad-lyrics-current');
  expect(line).toHaveStyle({ fontSize: '31.68px', whiteSpace: 'nowrap' });
  expect(screen.getByText('two').closest('.ad-lyrics-next')).toHaveStyle({
    fontSize: '32px',
  });
  const measurements = measure.mock.calls.length;
  rerender(view(20.2));
  expect(line).toHaveStyle({ fontSize: '31.68px' });
  expect(measure).toHaveBeenCalledTimes(measurements);
  measure.mockReturnValue(2000);
  rerender(view(20.2, { ...document }));
  expect(current.closest('.ad-lyrics-current')).toHaveStyle({
    fontSize: '24px',
    whiteSpace: 'normal',
  });
  expect(screen.getByText('two').closest('.ad-lyrics-next')).toHaveStyle({
    fontSize: '18px',
    whiteSpace: 'normal',
  });
  Object.assign(store.preferences, { karaokeLyricsLines: 3 });
  rerender(view(20.2));
  expect(screen.getByText('three')).toBeInTheDocument();
  Object.assign(store.preferences, { karaokeLyricsLayout: 'alternating' });
  rerender(view(21.2));
  expect(screen.getByText('two').closest('[data-lyric-row]')).toHaveAttribute(
    'data-slot',
    '1',
  );
  expect(screen.getByText('three').closest('[data-lyric-row]')).toHaveAttribute(
    'data-slot',
    '0',
  );
  measure.mockReturnValue(160);
  Object.assign(store.preferences, { karaokeLyricsLayout: 'credits' });
  rerender(view(22.2));
  expect(screen.getByText('two').closest('[data-lyric-row]')).toHaveAttribute(
    'data-slot',
    '0',
  );
  expect(
    screen.getByText('three').closest('.ad-lyrics-current'),
  ).toBeInTheDocument();
  expect(
    parseFloat(
      screen.getByText('three').style.getPropertyValue('--ad-lyric-fill'),
    ),
  ).toBeGreaterThan(0);
  expect(screen.getByText('four').closest('[data-lyric-row]')).toHaveAttribute(
    'data-slot',
    '2',
  );
  const creditsRow = screen
    .getByText('three')
    .closest<HTMLElement>('[data-lyric-row]');
  const previousTransform = creditsRow?.style.transform;
  rerender(view(22.4));
  expect(screen.getByText('three').closest('[data-lyric-row]')).toBe(
    creditsRow,
  );
  expect(creditsRow?.style.transform).not.toBe(previousTransform);
  expect(screen.getByText('three').closest('.ad-lyrics-current')).toHaveStyle({
    fontSize: '32px',
  });
  expect(screen.getByText('four').closest('.ad-lyrics-next')).toHaveStyle({
    fontSize: '32px',
  });
  expect(
    screen.getByText('three').closest('.ad-lyrics-current'),
  ).toBeInTheDocument();
  Object.assign(store.preferences, {
    karaokeLyricsLayout: 'classic',
    karaokeLyricsLines: 1,
  });
  rerender(view(22.2));
  expect(screen.queryByText('four')).not.toBeInTheDocument();
});

it('does not reveal lyrics before the three second countdown', () => {
  render(view(16.5));
  expect(screen.queryByText('one')).not.toBeInTheDocument();
  expect(screen.queryByText('two')).not.toBeInTheDocument();
});

it.each([false, true])(
  'keeps future notes paired with eligible lyric lines (activity: %s)',
  (filtered) => {
    const source = filtered
      ? { ...document, vocalActivity: [[20, 20.5]] as const }
      : document;
    render(view(19, source));
    expect(probe.props.at(-1)?.notes?.map((note) => note.id)).toEqual([
      'n0',
      ...(filtered ? [] : ['n1', 'n2', 'n3']),
    ]);
  },
);

it('keeps the roll mounted through empty sections and reveals it at the note window edge', () => {
  const { rerender } = render(view(0));
  const roll = screen.getByTestId('roll');
  const panel = roll.closest('.pianoRoll');
  expect(panel).toHaveAttribute('hidden');
  expect(panel).toHaveAttribute('inert');
  expect(probe.playing).toBe(false);
  rerender(view(14));
  expect(panel).toHaveAttribute('hidden');
  expect(probe.playing).toBe(false);
  rerender(view(17.01));
  expect(panel).not.toHaveAttribute('hidden');
  expect(probe.playing).toBe(true);
  rerender(view(80));
  expect(panel).toHaveAttribute('hidden');
  expect(probe.playing).toBe(false);
  expect(screen.getByTestId('roll')).toBe(roll);
  expect(probe.mounts).toBe(1);
});

it('uses the selected zoom window to determine when a note enters', () => {
  const { rerender } = render(view(17));
  const panel = screen.getByTestId('roll').closest('.pianoRoll');
  expect(panel).not.toHaveAttribute('hidden');
  act(() => {
    probe.props.at(-1)?.onWindowChange?.(2);
  });
  expect(panel).toHaveAttribute('hidden');
  rerender(view(19));
  expect(panel).not.toHaveAttribute('hidden');
});
