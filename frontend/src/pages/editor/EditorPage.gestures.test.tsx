import { setLocale, tr, type PianoRollProps } from '@neo-ui-kit/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { EditorDocument } from '../../application/editor/editorModel';
import type { PlaybackSnapshot, SongDto } from '../../contracts/models';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { clearStorage } from '../../shared/storage/localStore';
import '../../providers/localization';
import { editorApi } from './editorApi';
import { EditorPage } from './index';

const probe = vi.hoisted(() => ({ rollRenders: 0 }));
vi.mock('@neo-ui-kit/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@neo-ui-kit/react')>();
  return {
    ...actual,
    useRouter: () => ({ params: { songId: 'song' }, navigate: vi.fn() }),
    PianoRoll: (props: PianoRollProps) => {
      probe.rollRenders++;
      return <actual.PianoRoll {...props} />;
    },
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

it.each(['move', 'resize'] as const)(
  'keeps %s responsive to fine movement when snapping is disabled',
  async (kind) => {
    const { world, note, geometry } = await beginDrag(kind);
    fireEvent.click(screen.getByRole('button', { name: tr('editorSnap') }));
    pointer(world, 'pointermove', 130, kind === 'move' ? 80 : 100);
    const first = note.getAttribute('style');
    pointer(world, 'pointermove', 130.2, kind === 'move' ? 80 : 100);
    expect(note.getAttribute('style')).not.toBe(first);
    pointer(world, 'pointercancel', 130.2, 80);
    expect(note.getAttribute('style')).toBe(geometry);
    expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
  },
);
