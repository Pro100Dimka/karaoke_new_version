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
const saved: EditorDocument = {
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
  vi.mocked(editorApi.load).mockResolvedValue(saved);
  vi.mocked(editorApi.save).mockResolvedValue(2);
  vi.mocked(audioClient.prepareSong).mockResolvedValue(ready);
  vi.mocked(audioClient.stop).mockResolvedValue(ready);
});

const button = (key: string) => screen.getByRole('button', { name: tr(key) });
const note = (pitch: number) =>
  screen.getByRole('button', { name: tr('Нота {pitch}', { pitch }) });
const findNote = (pitch: number) =>
  screen.queryByRole('button', { name: tr('Нота {pitch}', { pitch }) });
const element = (parent: ParentNode, selector: string): HTMLElement => {
  const found = parent.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing editor element: ${selector}`);
  return found;
};
const geometry = (body: HTMLElement) =>
  body.closest('.ad-piano-roll-note')?.getAttribute('style');

// jsdom lacks pointer geometry/capture; the real PianoRoll owns all gesture handlers.
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
const press = (key: string, code = '', ctrlKey = false) =>
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key,
    code,
    ctrlKey,
  });
const openEditor = async () => {
  const view = render(<EditorPage />);
  await screen.findByRole('button', {
    name: tr('Нота {pitch}', { pitch: 60 }),
  });
  await waitFor(() => expect(audioClient.prepareSong).toHaveBeenCalledOnce());
  const world = element(view.container, '.ad-piano-roll-world');
  vi.spyOn(world, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 1000, 300),
  );
  return world;
};
const withUndoAndRedo = async () => {
  const world = await openEditor();
  fireEvent.keyDown(note(60), { key: 'ArrowUp' });
  fireEvent.keyDown(note(64), { key: 'ArrowUp' });
  fireEvent.click(button('undo'));
  expect(button('undo')).toBeEnabled();
  expect(button('redo')).toBeEnabled();
  return world;
};

const commands = {
  'Ctrl+Z': () => press('z', 'KeyZ', true),
  'Ctrl+Y': () => press('y', 'KeyY', true),
  Delete: () => press('Delete'),
  ArrowRight: () => press('ArrowRight'),
  'Ctrl+S': () => press('s', 'KeyS', true),
  'toolbar Undo': () => fireEvent.click(button('undo')),
  'toolbar Redo': () => fireEvent.click(button('redo')),
  'toolbar Delete': () => fireEvent.click(button('editorDeleteNotes')),
  'toolbar Save': () => fireEvent.click(button('save')),
};
const scenarios: {
  command: keyof typeof commands;
  finish: 'release' | 'Escape' | 'pointercancel';
}[] = [
  { command: 'Ctrl+Z', finish: 'release' },
  { command: 'Ctrl+Z', finish: 'Escape' },
  { command: 'Delete', finish: 'release' },
  { command: 'Delete', finish: 'pointercancel' },
  { command: 'Ctrl+Y', finish: 'Escape' },
  { command: 'ArrowRight', finish: 'release' },
  { command: 'Ctrl+S', finish: 'release' },
  { command: 'Ctrl+S', finish: 'Escape' },
  { command: 'toolbar Undo', finish: 'release' },
  { command: 'toolbar Redo', finish: 'Escape' },
  { command: 'toolbar Delete', finish: 'pointercancel' },
  { command: 'toolbar Save', finish: 'release' },
];

it.each(scenarios)(
  'ignores $command during a note drag, then preserves history after $finish',
  async ({ command, finish }) => {
    const world = await withUndoAndRedo();
    const body = note(61);
    const before = geometry(body);
    body.focus();
    pointer(body, 'pointerdown', 100, 100);
    pointer(world, 'pointermove', 130, 80);
    const preview = geometry(body);
    expect(preview).not.toBe(before);
    expect(note(62)).toBeInTheDocument();

    await act(async () => commands[command]());
    expect.soft(findNote(62)).toBeInTheDocument();
    expect.soft(findNote(64)).toBeInTheDocument();
    expect.soft(geometry(body)).toBe(preview);
    expect.soft(editorApi.save).not.toHaveBeenCalled();

    if (finish === 'Escape') {
      body.focus();
      press('Escape');
    } else
      pointer(
        world,
        finish === 'release' ? 'pointerup' : 'pointercancel',
        130,
        80,
      );

    if (finish === 'release') {
      expect.soft(findNote(62)).toBeInTheDocument();
      expect.soft(geometry(body)).toBe(preview);
      expect(button('redo')).toBeDisabled();
      fireEvent.click(button('undo'));
      expect(geometry(note(61))).toBe(before);
      fireEvent.click(button('undo'));
      expect(note(60)).toBeInTheDocument();
      expect(button('save')).toBeDisabled();
      fireEvent.click(button('redo'));
      fireEvent.click(button('redo'));
      expect(geometry(note(62))).toBe(preview);
    } else {
      expect.soft(findNote(61)).toBeInTheDocument();
      expect.soft(geometry(body)).toBe(before);
      expect(button('redo')).toBeEnabled();
      fireEvent.click(button('redo'));
      expect(note(65)).toBeInTheDocument();
      fireEvent.click(button('undo'));
      expect(note(64)).toBeInTheDocument();
      fireEvent.click(button('undo'));
      expect(note(60)).toBeInTheDocument();
      expect(button('save')).toBeDisabled();
    }
  },
);

it('keeps history commands idle between pointer-down and the first move', async () => {
  const world = await withUndoAndRedo();
  const body = note(61);
  body.focus();
  pointer(body, 'pointerdown', 100, 100);
  press('z', 'KeyZ', true);
  expect.soft(findNote(61)).toBeInTheDocument();
  pointer(world, 'pointerup', 100, 100);
  press('y', 'KeyY', true);
  expect(note(65)).toBeInTheDocument();
  press('z', 'KeyZ', true);
  press('z', 'KeyZ', true);
  expect(note(60)).toBeInTheDocument();
  expect(button('save')).toBeDisabled();
});

it.each(['start', 'end'] as const)(
  'cancels a %s-edge resize with Escape after a toolbar control held focus',
  async (edge) => {
    const world = await withUndoAndRedo();
    const body = note(61);
    const before = geometry(body);
    const parent = body.parentElement;
    if (!parent) throw new Error('Missing note container');
    const handle = element(parent, `[data-edge="${edge}"]`);
    const toolbar = button('editorGrid');
    toolbar.focus();
    expect(document.activeElement).toBe(toolbar);

    pointer(handle, 'pointerdown', 100, 100);
    pointer(world, 'pointermove', 130, 100);
    expect(geometry(body)).not.toBe(before);
    press('Escape');
    expect.soft(geometry(body)).toBe(before);
    pointer(world, 'pointerup', 130, 100);
    expect(geometry(body)).toBe(before);
    expect(button('redo')).toBeEnabled();
    fireEvent.click(button('redo'));
    expect(note(65)).toBeInTheDocument();
  },
);

it('cancels a selection rectangle with Escape after a toolbar control held focus', async () => {
  const world = await openEditor();
  const toolbar = button('editorGrid');
  toolbar.focus();
  pointer(world, 'pointerdown', 50, 50);
  pointer(world, 'pointermove', 850, 280);
  const box = element(world, '.ad-piano-roll-area');
  expect(box.style.display).toBe('block');
  press('Escape');
  expect.soft(box.style.display).toBe('none');
  pointer(world, 'pointerup', 850, 280);
  expect(note(60)).toHaveAttribute('aria-pressed', 'false');
  expect(note(64)).toHaveAttribute('aria-pressed', 'false');
  expect(button('editorDeleteNotes')).toBeDisabled();
  expect(button('save')).toBeDisabled();
});
