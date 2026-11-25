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
import type { PlaybackSnapshot } from '../../contracts/models';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { clearStorage } from '../../shared/storage/localStore';
import '../../providers/localization';
import { editorApi } from './editorApi';
import { EditorPage } from './index';

vi.mock('@neo-ui-kit/react', async (original) => ({
  ...(await original<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => ({ params: { songId: 'song' }, navigate: vi.fn() }),
}));
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
  audioClient: {
    prepareSong: vi.fn(),
    stop: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    observeSnapshots: vi.fn(),
  },
}));
vi.mock('./editorApi', () => ({ editorApi: { load: vi.fn(), save: vi.fn() } }));
vi.mock('./EditorTransport', () => ({
  EditorTransport: ({ onTogglePlay }: { onTogglePlay(): void }) => (
    <button onClick={onTogglePlay}>Preview test</button>
  ),
}));

const ready: PlaybackSnapshot = {
  sessionId: 'editor',
  state: 'ready',
  positionSeconds: 0,
  durationSeconds: 1200,
  monitoring: false,
  inputLevel: 0,
};
let publish: (snapshot: PlaybackSnapshot) => void;
let unsubscribe = vi.fn<() => void>();

const count = 3000;
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
const document: EditorDocument = {
  revision: 1,
  words: Array.from({ length: count }, (_, index) => ({
    id: `w${index}`,
    text: `Word ${index}`,
    start: index * 0.4,
    end: index * 0.4 + 0.35,
  })),
  notes: Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    wordId: `w${index}`,
    pitch: 60 + (index % 12),
    start: index * 0.4 + 0.05,
    end: index * 0.4 + 0.3,
  })),
};
beforeEach(() => {
  vi.resetAllMocks();
  clearStorage();
  setLocale('ru');
  vi.mocked(pythonClient.getSong).mockResolvedValue({
    id: 'song',
    title: 'Long song',
    artist: 'Singer',
    status: 'ready',
    activeRevision: 1,
    language: 'English',
    durationSeconds: 1200,
    createdAt: '2026-11-20',
    coverState: 'Fallback',
    projectFormatVersion: 1,
  });
  vi.mocked(pythonClient.projectCompatibility).mockResolvedValue('Current');
  vi.mocked(editorApi.load).mockResolvedValue(document);
  vi.mocked(editorApi.save).mockResolvedValue({ revision: 2 });
  vi.mocked(audioClient.seek).mockImplementation(async (positionSeconds) => ({
    ...ready,
    positionSeconds,
  }));
  for (const name of ['prepareSong', 'stop', 'play', 'pause'] as const)
    vi.mocked(audioClient[name]).mockResolvedValue(ready);
  unsubscribe = vi.fn<() => void>();
  vi.mocked(audioClient.observeSnapshots).mockImplementation((listener) => {
    publish = listener;
    return unsubscribe;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const openEditor = async () => {
  const view = render(<EditorPage />);
  await waitFor(() => expect(audioClient.prepareSong).toHaveBeenCalledOnce());
  const world = view.container.querySelector<HTMLElement>(
    '.ad-piano-roll-world',
  )!;
  const scroll = view.container.querySelector<HTMLElement>(
    '.ad-piano-roll-scroll',
  )!;
  let width = 900;
  const pixels = () =>
    parseFloat(
      world
        .closest<HTMLElement>('.ad-piano-roll')!
        .style.getPropertyValue('--ad-pps'),
    ) * 16;
  vi.spyOn(world, 'offsetWidth', 'get').mockImplementation(
    () => 1200 * pixels(),
  );
  vi.spyOn(scroll, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(world, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(64 - scroll.scrollLeft, 0, 1200 * pixels(), 440),
  );
  const scrollTo = (seconds: number) => {
    scroll.scrollLeft = seconds * pixels();
    fireEvent.scroll(scroll);
  };
  const note = (id: string) =>
    world.querySelector<HTMLElement>(`[data-note-id="${id}"]`);
  const button = (id: string) =>
    note(id)!.querySelector<HTMLButtonElement>('button')!;
  scrollTo(0);
  return {
    ...view,
    world,
    scroll,
    pixels,
    note,
    button,
    scrollTo,
    resize: (next: number) => {
      width = next;
      fireEvent(window, new Event('resize'));
    },
  };
};

it('bounds the initial note, word and ruler DOM to the viewport of a long document', async () => {
  const started = performance.now();
  const view = render(<EditorPage />);
  await waitFor(() => expect(audioClient.prepareSong).toHaveBeenCalledOnce());
  const notes = view.container.querySelectorAll('.ad-piano-roll-note').length;
  const words = view.container.querySelectorAll(
    '.ad-piano-roll-words > span',
  ).length;
  const ticks = view.container.querySelectorAll(
    '.ad-piano-roll-ruler > span',
  ).length;
  console.info(
    JSON.stringify({
      scenario: 'editor-opening-3000',
      notes,
      words,
      ticks,
      elapsedMs: performance.now() - started,
    }),
  );
  const world = view.container.querySelector<HTMLElement>(
    '.ad-piano-roll-world',
  )!;
  vi.spyOn(world, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 1200 * 128, 440),
  );
  const first = world.querySelector('.ad-piano-roll-note-body')!;
  pointer(first, 'pointerdown', 100, 100);
  const dragStarted = performance.now();
  for (let sample = 0; sample < 20; sample++)
    pointer(world, 'pointermove', 100, sample % 2 ? 60 : 80);
  const dragElapsedMs = performance.now() - dragStarted;
  pointer(world, 'pointerup', 100, 60);
  console.info(
    JSON.stringify({
      scenario: 'editor-20-real-drag-updates-3000',
      elapsedMs: dragElapsedMs,
    }),
  );
  expect(notes).toBeLessThan(100);
  expect(words).toBeLessThan(100);
  expect(ticks).toBeLessThan(40);
});

it('keeps absolute note/word positions while scrolling and updates bounds after zoom and layout changes', async () => {
  const view = await openEditor();
  const width = view.world.style.width;
  view.scrollTo(800);
  expect(view.note('n1')).toBeNull();
  expect(screen.queryByText('Word 0')).toBeNull();
  expect(screen.getByText('Word 2000').style.left).toBe(
    'calc(var(--ad-pps) * 800)',
  );
  expect(view.note('n2000')?.style.left).toBe('calc(var(--ad-pps) * 800.05)');
  expect(view.world.style.width).toBe(width);
  const before = view.world.querySelectorAll('.ad-piano-roll-note').length;
  view.resize(1800);
  expect(
    view.world.querySelectorAll('.ad-piano-roll-note').length,
  ).toBeGreaterThan(before);
  fireEvent.click(screen.getByRole('button', { name: tr('zoomIn') }));
  expect(view.pixels()).toBe(192);
  expect(view.note('n2000')).toBeNull();
  expect(
    view.world.querySelectorAll('.ad-piano-roll-note').length,
  ).toBeLessThan(110);
  view.scrollTo(800);
  expect(view.note('n2000')).not.toBeNull();
});

it('selects and moves offscreen members of a rectangle and retains the full group for delete, undo and redo', async () => {
  const view = await openEditor();
  expect(view.note('n1999')).toBeNull();
  pointer(view.world, 'pointerdown', 64, 0);
  pointer(view.world, 'pointermove', 64 + 800 * view.pixels(), 440);
  pointer(view.world, 'pointerup', 64 + 800 * view.pixels(), 440);
  expect(view.button('n0')).toHaveAttribute('aria-pressed', 'true');
  pointer(view.button('n0'), 'pointerdown', 100, 100);
  pointer(view.world, 'pointermove', 100, 80);
  pointer(view.world, 'pointerup', 100, 80);
  view.scrollTo(799);
  expect(view.button('n1999')).toHaveAttribute('aria-pressed', 'true');
  expect(view.button('n1999')).toHaveAccessibleName(
    tr('Нота {pitch}', { pitch: 68 }),
  );
  expect(view.button('n2001')).toHaveAttribute('aria-pressed', 'false');
  expect(view.button('n2001')).toHaveAccessibleName(
    tr('Нота {pitch}', { pitch: 69 }),
  );
  fireEvent.keyDown(view.world, { key: 'Delete' });
  expect(view.note('n1999')).toBeNull();
  expect(view.note('n2001')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: tr('undo') }));
  expect(view.button('n1999')).toHaveAccessibleName(
    tr('Нота {pitch}', { pitch: 68 }),
  );
  fireEvent.click(screen.getByRole('button', { name: tr('undo') }));
  expect(view.button('n1999')).toHaveAccessibleName(
    tr('Нота {pitch}', { pitch: 67 }),
  );
  expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: tr('redo') }));
  expect(view.button('n1999')).toHaveAccessibleName(
    tr('Нота {pitch}', { pitch: 68 }),
  );
});

it.each(
  (['move', 'resize'] as const).flatMap((kind) =>
    ['pointercancel', 'lostpointercapture', 'Escape'].map((cancel) => ({
      kind,
      cancel,
    })),
  ),
)(
  'pins the captured $kind target across scrolling and cancels with $cancel without committing',
  async ({ kind, cancel }) => {
    const view = await openEditor();
    const note = view.note('n1')!;
    const geometry = note.getAttribute('style');
    const target =
      kind === 'move'
        ? view.button('n1')
        : note.querySelector<HTMLElement>('[data-edge="end"]')!;
    const capture = vi.spyOn(target, 'setPointerCapture');
    pointer(target, 'pointerdown', 100, 100);
    pointer(view.world, 'pointermove', kind === 'move' ? 100 : 130, 80);
    expect(note.getAttribute('style')).not.toBe(geometry);
    view.scrollTo(800);
    expect(view.note('n1')).toBe(note);
    expect(target.isConnected).toBe(true);
    expect(capture).toHaveBeenCalledWith(1);
    if (cancel === 'Escape') fireEvent.keyDown(target, { key: 'Escape' });
    else pointer(target, cancel, 130, 80);
    if (kind === 'resize') {
      // Resize focuses the note so keyboard cancellation reaches the roll.
      expect(view.button('n1')).toHaveFocus();
      expect(view.note('n1')).toBe(note);
      expect(note.getAttribute('style')).toBe(geometry);
      act(() => view.button('n1').blur());
    }
    expect(view.note('n1')).toBeNull();
    view.scrollTo(0);
    expect(view.note('n1')?.getAttribute('style')).toBe(geometry);
    expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
    expect(screen.getByRole('button', { name: tr('undo') })).toBeDisabled();
  },
);

it('keeps the focused element mounted offscreen and tabs in full document order with keyboard editing', async () => {
  const view = await openEditor();
  const first = view.button('n1');
  act(() => first.focus());
  view.scrollTo(800);
  expect(view.button('n1')).toBe(first);
  expect(window.document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'ArrowUp' });
  expect(view.button('n1')).toBe(first);
  expect(first).toHaveAccessibleName(tr('Нота {pitch}', { pitch: 62 }));
  fireEvent.keyDown(first, { key: 'Tab' });
  expect(window.document.activeElement).toBe(view.button('n2'));
  expect(view.scroll.scrollLeft).toBe(0);
  const last = [
    ...view.world.querySelectorAll<HTMLButtonElement>(
      '.ad-piano-roll-note-body',
    ),
  ].at(-2)!;
  const lastId = Number(last.parentElement!.dataset.noteId!.slice(1));
  act(() => last.focus());
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(window.document.activeElement).toBe(view.button(`n${lastId + 1}`));
  expect(view.scroll.scrollLeft).toBeGreaterThan(0);
  fireEvent.keyDown(window.document.activeElement!, {
    key: 'Tab',
    shiftKey: true,
  });
  expect(window.document.activeElement).toBe(view.button(`n${lastId}`));
  view.scrollTo(1200);
  const final = view.button('n2999');
  act(() => final.focus());
  expect(fireEvent.keyDown(final, { key: 'Tab' })).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: tr('save') }));
  await waitFor(() => expect(editorApi.save).toHaveBeenCalledOnce());
  const saved = vi.mocked(editorApi.save).mock.calls[0]![1];
  expect(saved.notes).toHaveLength(3000);
  expect(saved.words).toHaveLength(3000);
  expect(saved.notes[1]?.pitch).toBe(62);
  expect(saved.notes[2999]?.pitch).toBe(document.notes[2999]?.pitch);
});

it('preserves the first and last native note tab stops after scrolling away from both', async () => {
  const view = await openEditor();
  view.scrollTo(800);
  const buttons = [
    ...view.world.querySelectorAll<HTMLButtonElement>(
      '.ad-piano-roll-note-body',
    ),
  ];
  expect(buttons[0]?.parentElement?.dataset.noteId).toBe('n0');
  expect(buttons.at(-1)?.parentElement?.dataset.noteId).toBe('n2999');
});

it('lets native focus reveal the next note vertically across a wide pitch range', async () => {
  vi.mocked(editorApi.load).mockResolvedValue({
    ...document,
    notes: document.notes.map((note, index) =>
      index === 0
        ? { ...note, pitch: 24 }
        : index === 1
          ? { ...note, pitch: 96 }
          : note,
    ),
  });
  const view = await openEditor();
  const first = view.button('n0');
  const next = view.button('n1');
  act(() => first.focus());
  view.scroll.scrollTop = 1000;
  const focus = vi.spyOn(next, 'focus');
  fireEvent.keyDown(first, { key: 'Tab' });
  expect(view.note('n1')?.style.top).toBe('calc(0%)');
  expect(window.document.activeElement).toBe(next);
  // jsdom does not lay out/scroll focus. The browser must be allowed to reveal
  // both axes instead of having its native scroll disabled by FocusOptions.
  expect(focus).toHaveBeenCalledWith();
});

it('responds to ResizeObserver geometry changes and disconnects the viewport observers on unmount', async () => {
  const observers: ResizeProbe[] = [];
  class ResizeProbe implements ResizeObserver {
    targets: Element[] = [];
    disconnect = vi.fn();
    constructor(private callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    unobserve() {}
    resize() {
      this.callback([], this);
    }
  }
  vi.stubGlobal('ResizeObserver', ResizeProbe);
  const view = await openEditor();
  view.scrollTo(800);
  const observer = observers.find((item) =>
    item.targets.includes(view.scroll),
  )!;
  expect(observer.targets).toContain(view.world);
  const before = view.world.querySelectorAll('.ad-piano-roll-note').length;
  vi.spyOn(view.scroll, 'clientWidth', 'get').mockReturnValue(1800);
  act(() => observer.resize());
  expect(
    view.world.querySelectorAll('.ad-piano-roll-note').length,
  ).toBeGreaterThan(before);
  view.unmount();
  expect(observer.disconnect).toHaveBeenCalledOnce();
});

it('updates the newly visible clock immediately after a distant follow jump and retains paused highlighting', async () => {
  const view = await openEditor();
  fireEvent.click(screen.getByRole('button', { name: 'Preview test' }));
  await waitFor(() =>
    expect(audioClient.observeSnapshots).toHaveBeenCalledOnce(),
  );
  act(() => publish({ ...ready, state: 'playing', positionSeconds: 800.2 }));
  expect(view.note('n2000')).toHaveAttribute('data-now');
  expect(screen.getByText('Word 2000')).toHaveAttribute('data-now');
  expect(view.note('n1')).toBeNull();
  expect(
    view.world.querySelectorAll('.ad-piano-roll-note').length,
  ).toBeLessThan(100);
  fireEvent.click(screen.getByRole('button', { name: tr('editorFollow') }));
  view.scrollTo(0);
  act(() => publish({ ...ready, state: 'playing', positionSeconds: 800.25 }));
  expect(view.scroll.scrollLeft).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Preview test' }));
  await waitFor(() => expect(audioClient.pause).toHaveBeenCalledOnce());
  view.scrollTo(800);
  expect(view.note('n2000')).toHaveAttribute('data-now');
  expect(screen.getByText('Word 2000')).toHaveAttribute('data-now');
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(
    vi.mocked(audioClient.observeSnapshots).mock.calls.length,
  );
});

it('retains overlapping notes and source order even when timeline entries are unsorted', async () => {
  vi.mocked(editorApi.load).mockResolvedValue({
    ...document,
    words: [
      document.words[2500]!,
      { id: 'long', text: 'Long', start: 0, end: 1100 },
      document.words[2000]!,
    ],
    notes: [
      document.notes[0]!,
      document.notes[2500]!,
      { id: 'long-note', wordId: 'long', pitch: 50, start: 0, end: 1100 },
      document.notes[2000]!,
      document.notes[2999]!,
    ],
  });
  const view = await openEditor();
  view.scrollTo(800);
  expect(
    [...view.world.querySelectorAll<HTMLElement>('[data-note-id]')].map(
      (item) => item.dataset.noteId,
    ),
  ).toEqual(['n0', 'long-note', 'n2000', 'n2999']);
  expect(
    [...view.container.querySelectorAll<HTMLElement>('[data-word-id]')].map(
      (item) => item.dataset.wordId,
    ),
  ).toEqual(['long', 'w2000']);
  view.scrollTo(1000);
  expect(
    [...view.world.querySelectorAll<HTMLElement>('[data-note-id]')].map(
      (item) => item.dataset.noteId,
    ),
  ).toEqual(['n0', 'n2500', 'long-note', 'n2999']);
});

it('preserves full-timeline ruler/grid seeking and cancels an area without changing selection', async () => {
  const view = await openEditor();
  const ruler = view.container.querySelector<HTMLElement>(
    '.ad-piano-roll-ruler',
  )!;
  vi.spyOn(ruler, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(64, 0, 1200 * 128, 24),
  );
  await act(async () => pointer(ruler, 'pointerdown', 64 + 2 * 128, 10));
  const owner = vi.mocked(audioClient.seek).mock.calls.at(-1)?.[1];
  expect(audioClient.seek).toHaveBeenLastCalledWith(2, expect.any(Function));
  expect(owner?.()).toBe(true);
  await act(async () => {
    pointer(view.world, 'pointerdown', 64 + 5 * 128, 100);
    pointer(view.world, 'pointerup', 64 + 5 * 128, 100);
  });
  expect(audioClient.seek).toHaveBeenLastCalledWith(5, owner);
  expect(owner?.()).toBe(true);
  pointer(view.button('n1'), 'pointerdown', 100, 100);
  pointer(view.world, 'pointerup', 100, 100);
  pointer(view.world, 'pointerdown', 64, 0);
  pointer(view.world, 'pointermove', 800, 400);
  pointer(view.world, 'pointercancel', 800, 400);
  expect(view.button('n1')).toHaveAttribute('aria-pressed', 'true');
  expect(view.button('n2')).toHaveAttribute('aria-pressed', 'false');
  expect(
    view.world.querySelector<HTMLElement>('.ad-piano-roll-area')?.style.display,
  ).toBe('none');
  expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
  expect(audioClient.seek).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(owner?.()).toBe(false);
});
