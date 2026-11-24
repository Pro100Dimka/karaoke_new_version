import { setLocale, tr } from '@neo-ui-kit/react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EditorDocument } from '../../application/editor/editorModel';
import type { PlaybackSnapshot, SongDto } from '../../contracts/models';
import { ask } from '../../providers/dialog';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { clearStorage } from '../../shared/storage/localStore';
import '../../providers/localization';
import { editorApi } from './editorApi';
import { loadDraft, saveDraft } from './editorDraft';
import { EditorPage } from './index';
import type { EditorPianoRollProps } from './EditorPianoRoll';

const probe = vi.hoisted(() => ({ rollRenders: 0 }));
vi.mock('@neo-ui-kit/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@neo-ui-kit/react')>();
  return {
    ...actual,
    useRouter: () => ({ params: { songId: 'song' }, navigate: vi.fn() }),
  };
});
vi.mock('./EditorPianoRoll', async (original) => {
  const actual = await original<typeof import('./EditorPianoRoll')>();
  const { Profiler } = await import('react');
  return {
    EditorPianoRoll: (props: EditorPianoRollProps) => (
      <Profiler
        id="editor-roll"
        onRender={() => {
          probe.rollRenders++;
        }}
      >
        <actual.EditorPianoRoll {...props} />
      </Profiler>
    ),
  };
});
vi.mock('../../app/TitleBar', () => ({
  titleBarLeadingId: 'editor-test-header',
}));
vi.mock('../../providers/close-guards', () => ({ useCloseGuard: vi.fn() }));
vi.mock('../../providers/dialog', () => ({ ask: vi.fn() }));
vi.mock('../../providers/notifications', () => ({ useNotify: () => vi.fn() }));
vi.mock('../../services/pythonClient', () => ({
  pythonClient: { getSong: vi.fn(), projectCompatibility: vi.fn() },
}));
vi.mock('../../services/audioClient', () => ({
  audioClient: { prepareSong: vi.fn(), stop: vi.fn() },
}));
vi.mock('./editorApi', () => ({ editorApi: { load: vi.fn(), save: vi.fn() } }));
vi.mock('./EditorTransport', () => ({ EditorTransport: () => null }));

const song: SongDto = {
  id: 'song',
  title: 'Song',
  artist: 'Singer',
  status: 'ready',
  activeRevision: 1,
  language: 'English',
  durationSeconds: 10,
  createdAt: '2026-11-20',
  coverState: 'Fallback',
  projectFormatVersion: 1,
};
const document: EditorDocument = {
  revision: 1,
  words: [
    { id: 'word', text: 'Voice', start: 0, end: 5 },
    { id: 'other-word', text: 'Other', start: 6, end: 9 },
  ],
  notes: [
    { id: 'note', wordId: 'word', pitch: 60, start: 1.03456, end: 2.13456 },
    { id: 'other', wordId: 'other-word', pitch: 64, start: 7, end: 8 },
  ],
};
const readySnapshot: PlaybackSnapshot = {
  sessionId: 'editor-session',
  state: 'ready',
  positionSeconds: 0,
  durationSeconds: 10,
  monitoring: false,
  inputLevel: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  probe.rollRenders = 0;
  clearStorage();
  setLocale('ru');
  vi.mocked(pythonClient.getSong).mockResolvedValue(song);
  vi.mocked(pythonClient.projectCompatibility).mockResolvedValue('Current');
  vi.mocked(editorApi.load).mockResolvedValue(document);
  vi.mocked(audioClient.prepareSong).mockResolvedValue(readySnapshot);
  vi.mocked(audioClient.stop).mockResolvedValue(readySnapshot);
});
afterEach(() => vi.useRealTimers());

// jsdom has no pointer constructor or geometry; retain the actual PianoRoll handlers.
const pointer = (target: Element, type: string, x: number, y: number) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  fireEvent(target, event);
};

const beginDrag = async (kind: 'move' | 'resize', width = 1000) => {
  const view = render(<EditorPage />);
  const body = await screen.findByRole('button', {
    name: tr('Нота {pitch}', { pitch: 60 }),
  });
  await waitFor(() => expect(audioClient.prepareSong).toHaveBeenCalledOnce());
  const note = body.closest('.ad-piano-roll-note')!;
  const world = view.container.querySelector<HTMLElement>(
    '.ad-piano-roll-world',
  )!;
  vi.spyOn(world, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, width, 300),
  );
  const geometry = note.getAttribute('style');
  const handle =
    kind === 'move' ? body : note.querySelector('[data-edge="end"]')!;
  pointer(handle, 'pointerdown', 100, 100);
  pointer(world, 'pointermove', 130, kind === 'move' ? 80 : 100);
  expect(note.getAttribute('style')).not.toBe(geometry);
  expect(screen.getByRole('button', { name: tr('save') })).toBeEnabled();
  return { world, note, geometry, body };
};

it.each(
  (['move', 'resize'] as const).flatMap((kind) =>
    (['Escape', 'pointercancel'] as const).map((cancel) => ({ kind, cancel })),
  ),
)(
  'cancels $kind with $cancel without changing off-grid notes or history',
  async ({ kind, cancel }) => {
    const { world, note, geometry } = await beginDrag(kind);
    if (cancel === 'Escape') fireEvent.keyDown(world, { key: 'Escape' });
    else pointer(world, 'pointercancel', 130, 80);

    expect(note.getAttribute('style')).toBe(geometry);
    expect(
      screen.getByRole('button', { name: tr('Нота {pitch}', { pitch: 60 }) }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
    expect(screen.getByRole('button', { name: tr('undo') })).toBeDisabled();
    expect(screen.getByRole('button', { name: tr('redo') })).toBeDisabled();
    expect(editorApi.save).not.toHaveBeenCalled();
  },
);

it.each(['move', 'resize'] as const)(
  'does not rebuild a large roll for repeated %s samples inside one snap cell',
  async (kind) => {
    const count = 500;
    vi.mocked(editorApi.load).mockResolvedValue({
      ...document,
      words: [
        ...document.words,
        ...Array.from({ length: count }, (_, index) => ({
          id: `w-${index}`,
          text: `Word ${index}`,
          start: 10 + index * 2,
          end: 11 + index * 2,
        })),
      ],
      notes: [
        ...document.notes,
        ...Array.from({ length: count }, (_, index) => ({
          id: `n-${index}`,
          wordId: `w-${index}`,
          pitch: 65,
          start: 10 + index * 2,
          end: 11 + index * 2,
        })),
      ],
    });
    const { world, note, geometry, body } = await beginDrag(
      kind,
      (11 + (count - 1) * 2) * 100,
    );
    const changed = note.getAttribute('style');
    const renders = probe.rollRenders;
    for (let sample = 0; sample < 30; sample++)
      pointer(
        world,
        'pointermove',
        130 + (sample % 4) / 10,
        kind === 'move' ? 80 : 100,
      );
    expect(note.getAttribute('style')).toBe(changed);
    expect(probe.rollRenders - renders).toBe(0);
    pointer(world, 'pointerup', 130, 80);
    fireEvent.click(screen.getByRole('button', { name: tr('undo') }));
    expect(note.getAttribute('style')).toBe(geometry);
    pointer(
      kind === 'move' ? body : note.querySelector('[data-edge="end"]')!,
      'pointerdown',
      100,
      100,
    );
    pointer(world, 'pointermove', 130, kind === 'move' ? 80 : 100);
    expect(note.getAttribute('style')).toBe(changed);
    pointer(world, 'pointercancel', 130, 80);
    expect(note.getAttribute('style')).toBe(geometry);
  },
);

it.each(['move', 'resize'] as const)(
  'commits a completed %s as one reversible history step',
  async (kind) => {
    const { world, note, geometry } = await beginDrag(kind);
    const changed = note.getAttribute('style');
    pointer(world, 'pointerup', 130, 80);
    fireEvent.click(screen.getByRole('button', { name: tr('undo') }));
    expect(note.getAttribute('style')).toBe(geometry);
    expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
    expect(screen.getByRole('button', { name: tr('undo') })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: tr('redo') }));
    expect(note.getAttribute('style')).toBe(changed);
    expect(screen.getByRole('button', { name: tr('save') })).toBeEnabled();
  },
);

it('does not reread distant word ends to recalculate duration during note-only drag previews', async () => {
  const source: EditorDocument = {
    ...document,
    words: [
      ...document.words,
      ...Array.from({ length: 500 }, (_, index) => ({
        id: `far-${index}`,
        text: `Word ${index}`,
        start: 10 + index * 2,
        end: 11 + index * 2,
      })),
    ],
  };
  vi.mocked(editorApi.load).mockResolvedValue(source);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const request = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
  const cancel = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((id) => {
      frames.delete(id);
    });
  try {
    const { world, note } = await beginDrag('move', 1009 * 100);
    const before = note.getAttribute('style');
    const renders = probe.rollRenders;
    let reads = 0;
    for (const word of source.words.slice(100)) {
      const end = word.end;
      Object.defineProperty(word, 'end', {
        get: () => {
          reads++;
          return end;
        },
      });
    }
    for (let step = 1; step <= 20; step++) {
      pointer(world, 'pointermove', 130 + step * 10, 80);
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(performance.now());
      });
    }
    expect(probe.rollRenders - renders).toBeGreaterThanOrEqual(20);
    expect(note.getAttribute('style')).not.toBe(before);
    expect(reads).toBe(0);
    pointer(world, 'pointercancel', 330, 80);
  } finally {
    request.mockRestore();
    cancel.mockRestore();
  }
});

it.each(['move', 'resize'] as const)(
  'keeps %s responsive to fine movement when snapping is disabled',
  async (kind) => {
    const { world, note, geometry } = await beginDrag(kind);
    fireEvent.click(screen.getByRole('button', { name: tr('editorSnap') }));
    pointer(world, 'pointermove', 130, kind === 'move' ? 80 : 100);
    const first = note.getAttribute('style');
    pointer(world, 'pointermove', 130.2, kind === 'move' ? 80 : 100);
    // Fine movement is visible on the next paint, even within the old snap cell.
    await waitFor(() => expect(note.getAttribute('style')).not.toBe(first));
    pointer(world, 'pointercancel', 130.2, 80);
    expect(note.getAttribute('style')).toBe(geometry);
    expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
  },
);

it.each([
  { constraint: 'snap grid', end: 2.15, pointerX: 101 },
  { constraint: 'word boundary', end: 5, pointerX: 130 },
])(
  'keeps Redo when the $constraint prevents a resize from changing the note',
  async ({ end, pointerX }) => {
    vi.mocked(editorApi.load).mockResolvedValue({
      ...document,
      notes: [{ ...document.notes[0]!, end }, ...document.notes.slice(1)],
    });
    const view = render(<EditorPage />);
    const body = await screen.findByRole('button', {
      name: tr('Нота {pitch}', { pitch: 60 }),
    });
    await waitFor(() => expect(audioClient.prepareSong).toHaveBeenCalledOnce());
    const world = view.container.querySelector<HTMLElement>(
      '.ad-piano-roll-world',
    )!;
    vi.spyOn(world, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 1000, 300),
    );
    fireEvent.keyDown(body, { key: 'ArrowUp' });
    fireEvent.click(screen.getByRole('button', { name: tr('undo') }));
    const redo = screen.getByRole('button', { name: tr('redo') });
    expect(redo).toBeEnabled();

    const note = body.closest('.ad-piano-roll-note')!;
    const geometry = note.getAttribute('style');
    pointer(note.querySelector('[data-edge="end"]')!, 'pointerdown', 100, 100);
    pointer(world, 'pointermove', pointerX, 100);
    pointer(world, 'pointerup', pointerX, 100);

    expect(note.getAttribute('style')).toBe(geometry);
    expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
    expect(redo).toBeEnabled();
    expect(screen.getByRole('button', { name: tr('undo') })).toBeDisabled();
    fireEvent.click(redo);
    expect(
      screen.getByRole('button', { name: tr('Нота {pitch}', { pitch: 61 }) }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr('save') })).toBeEnabled();
    expect(editorApi.save).not.toHaveBeenCalled();
  },
);

it.each(
  (['Escape', 'pointercancel'] as const).flatMap((cancel) =>
    [false, true].map((previousDraft) => ({ cancel, previousDraft })),
  ),
)(
  'restores recovery state after $cancel cancels an autosaved drag (previous draft: $previousDraft)',
  async ({ cancel, previousDraft }) => {
    const previous = {
      baseRevision: document.revision,
      document: {
        ...document,
        notes: [
          { ...document.notes[0]!, pitch: 67 },
          ...document.notes.slice(1),
        ],
      },
    };
    if (previousDraft) {
      saveDraft('song', previous);
      vi.mocked(ask).mockResolvedValue(null);
    }
    const view = render(<EditorPage />);
    const body = await screen.findByRole('button', {
      name: tr('Нота {pitch}', { pitch: 60 }),
    });
    await waitFor(() => expect(audioClient.prepareSong).toHaveBeenCalledOnce());
    const note = body.closest('.ad-piano-roll-note')!;
    const geometry = note.getAttribute('style');
    const world = view.container.querySelector<HTMLElement>(
      '.ad-piano-roll-world',
    )!;
    vi.spyOn(world, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 1000, 300),
    );
    vi.useFakeTimers();
    pointer(body, 'pointerdown', 100, 100);
    pointer(world, 'pointermove', 130, 80);
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(loadDraft('song')?.document.notes[0]?.pitch).toBe(61);

    if (cancel === 'Escape') fireEvent.keyDown(world, { key: 'Escape' });
    else pointer(world, 'pointercancel', 130, 80);

    expect(note.getAttribute('style')).toBe(geometry);
    expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
    expect(screen.getByRole('button', { name: tr('undo') })).toBeDisabled();
    expect(loadDraft('song')).toEqual(previousDraft ? previous : null);
    vi.useRealTimers();
    view.unmount();
    render(<EditorPage />);
    await waitFor(() =>
      expect(audioClient.prepareSong).toHaveBeenCalledTimes(2),
    );
    expect(
      screen.getByRole('button', { name: tr('Нота {pitch}', { pitch: 60 }) }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
    expect(ask).toHaveBeenCalledTimes(previousDraft ? 2 : 0);
  },
);
