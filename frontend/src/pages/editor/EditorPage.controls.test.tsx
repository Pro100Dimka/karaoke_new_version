import { setLocale, tr } from '@neo-ui-kit/react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { EditorDocument } from '../../application/editor/editorModel';
import type { PlaybackSnapshot, SongDto } from '../../contracts/models';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { clearStorage } from '../../shared/storage/localStore';
import '../../providers/localization';
import { editorApi } from './editorApi';
import { EditorPage } from './index';

vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
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
    { id: 'note', wordId: 'word', pitch: 60, start: 1, end: 2 },
    { id: 'other', wordId: 'other-word', pitch: 64, start: 7, end: 8 },
  ],
};
const ready: PlaybackSnapshot = {
  sessionId: 'editor-session',
  state: 'ready',
  positionSeconds: 0,
  durationSeconds: 10,
  monitoring: false,
  inputLevel: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  clearStorage();
  setLocale('ru');
  vi.mocked(pythonClient.getSong).mockResolvedValue(song);
  vi.mocked(pythonClient.projectCompatibility).mockResolvedValue('Current');
  vi.mocked(editorApi.load).mockResolvedValue(document);
  vi.mocked(editorApi.save).mockResolvedValue(2);
  vi.mocked(audioClient.prepareSong).mockResolvedValue(ready);
  vi.mocked(audioClient.stop).mockResolvedValue(ready);
});

const noteButton = (pitch: number) =>
  screen.getByRole('button', {
    name: tr('Нота {pitch}', { pitch }),
  });
const selectedNotes = () =>
  screen
    .getAllByRole('button')
    .filter(
      (element) =>
        element.classList.contains('ad-piano-roll-note-body') &&
        element.getAttribute('aria-pressed') === 'true',
    );
const openEditor = async () => {
  const view = render(<EditorPage />);
  await screen.findByRole('button', {
    name: tr('Нота {pitch}', { pitch: 60 }),
  });
  await waitFor(() => expect(audioClient.prepareSong).toHaveBeenCalledOnce());
  const world = view.container.querySelector<HTMLElement>(
    '.ad-piano-roll-world',
  )!;
  vi.spyOn(world, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 1000, 300),
  );
  return world;
};

// jsdom omits pointer geometry; events still use the real PianoRoll handlers.
const pointer = (
  target: Element,
  type: string,
  x = 100,
  y = 100,
  ctrlKey = false,
) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
    ctrlKey,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  fireEvent(target, event);
};
const selectNote = (world: Element, pitch: number, additive = false) => {
  pointer(noteButton(pitch), 'pointerdown', 100, 100, additive);
  pointer(world, 'pointerup');
};

it('does not publish unchanged revisions when Ctrl+S is repeated or edits are undone', async () => {
  const world = await openEditor();
  const save = async () =>
    act(async () => {
      fireEvent.keyDown(world, { key: 's', code: 'KeyS', ctrlKey: true });
    });

  await save();
  expect(editorApi.save).not.toHaveBeenCalled();

  fireEvent.keyDown(noteButton(60), { key: 'ArrowUp' });
  fireEvent.click(screen.getByRole('button', { name: tr('undo') }));
  await save();
  expect(editorApi.save).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: tr('redo') }));
  await save();
  expect(editorApi.save).toHaveBeenCalledOnce();
  expect(vi.mocked(editorApi.save).mock.calls[0]?.[1].notes[0]?.pitch).toBe(61);
  await save();
  await save();
  expect(editorApi.save).toHaveBeenCalledOnce();
  expect(audioClient.prepareSong).toHaveBeenCalledTimes(2);
});

it('keeps a moved group selected for Delete and restores both edits with undo', async () => {
  const world = await openEditor();
  selectNote(world, 60);
  selectNote(world, 64, true);
  expect(selectedNotes()).toHaveLength(2);

  pointer(noteButton(60), 'pointerdown');
  pointer(world, 'pointermove', 130, 80);
  pointer(world, 'pointerup', 130, 80);
  expect(noteButton(61)).toBeInTheDocument();
  expect(noteButton(65)).toBeInTheDocument();
  expect(selectedNotes()).toHaveLength(2);

  fireEvent.keyDown(world, { key: 'Delete' });
  expect(world.querySelectorAll('.ad-piano-roll-note')).toHaveLength(0);
  expect(screen.getByText('Voice')).toBeInTheDocument();
  expect(screen.getByText('Other')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: tr('undo') }));
  expect(noteButton(61)).toBeInTheDocument();
  expect(noteButton(65)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: tr('undo') }));
  expect(noteButton(60)).toBeInTheDocument();
  expect(noteButton(64)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
});

it('still toggles an additive selection and replaces it when another note is clicked', async () => {
  const world = await openEditor();
  selectNote(world, 60);
  selectNote(world, 64, true);
  selectNote(world, 60);
  expect(selectedNotes()).toEqual([noteButton(60)]);
  selectNote(world, 64, true);
  selectNote(world, 64, true);
  expect(selectedNotes()).toEqual([noteButton(60)]);
  selectNote(world, 64);
  expect(selectedNotes()).toEqual([noteButton(64)]);
  expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
});

it.each([
  { layout: 'Russian', save: 'ы', undo: 'я', redo: 'н', physical: true },
  { layout: 'Ukrainian', save: 'і', undo: 'я', redo: 'н', physical: true },
  { layout: 'English', save: 's', undo: 'z', redo: 'y', physical: true },
  {
    layout: 'key-only events',
    save: 's',
    undo: 'z',
    redo: 'y',
    physical: false,
  },
])('saves, undoes and redoes from the $layout keyboard', async (layout) => {
  const world = await openEditor();
  const shortcut = (key: string, code: string, shiftKey = false) =>
    fireEvent.keyDown(world, {
      key,
      code: layout.physical ? code : undefined,
      ctrlKey: true,
      shiftKey,
    });
  fireEvent.keyDown(noteButton(60), { key: 'ArrowUp' });
  expect(noteButton(61)).toBeInTheDocument();

  shortcut(layout.undo, 'KeyZ');
  expect(noteButton(60)).toBeInTheDocument();
  shortcut(layout.redo, 'KeyY');
  expect(noteButton(61)).toBeInTheDocument();
  shortcut(layout.undo, 'KeyZ');
  shortcut(layout.undo, 'KeyZ', true);
  expect(noteButton(61)).toBeInTheDocument();
  shortcut(layout.save, 'KeyS');
  await waitFor(() => expect(editorApi.save).toHaveBeenCalledOnce());
  expect(vi.mocked(editorApi.save).mock.calls[0]?.[1].notes[0]?.pitch).toBe(61);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled(),
  );
});
