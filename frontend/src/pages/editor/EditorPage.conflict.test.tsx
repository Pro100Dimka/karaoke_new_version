import { setLocale, tr } from '@neo-ui-kit/react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { EditorDocument } from '../../application/editor/editorModel';
import type { PlaybackSnapshot, SongDto } from '../../contracts/models';
import { DialogView } from '../../providers/dialog';
import '../../providers/localization';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { routes } from '../../shared/routes';
import { clearStorage } from '../../shared/storage/localStore';
import { editorApi } from './editorApi';
import { EditorPage } from './index';

const shell = vi.hoisted(() => ({ navigate: vi.fn(), notify: vi.fn() }));
vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => ({ params: { songId: 'song' }, navigate: shell.navigate }),
}));
vi.mock('../../app/TitleBar', () => ({
  titleBarLeadingId: 'editor-test-header',
}));
vi.mock('../../providers/close-guards', () => ({ useCloseGuard: vi.fn() }));
vi.mock('../../providers/notifications', () => ({
  useNotify: () => shell.notify,
}));
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
  words: [{ id: 'word', text: 'Voice', start: 0, end: 5 }],
  notes: [{ id: 'note', wordId: 'word', pitch: 60, start: 1, end: 2 }],
};
const reloaded: EditorDocument = {
  ...saved,
  revision: 2,
  notes: [{ ...saved.notes[0]!, pitch: 65 }],
};
const ready: PlaybackSnapshot = {
  sessionId: 'editor-session',
  state: 'ready',
  positionSeconds: 0,
  durationSeconds: 10,
  monitoring: false,
  inputLevel: 0,
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.resetAllMocks();
  clearStorage();
  setLocale('en');
  vi.mocked(pythonClient.getSong).mockResolvedValue(song);
  vi.mocked(pythonClient.projectCompatibility).mockResolvedValue('Current');
  vi.mocked(editorApi.load)
    .mockResolvedValueOnce(saved)
    .mockResolvedValue(reloaded);
  vi.mocked(editorApi.save)
    .mockRejectedValueOnce({
      code: 'RevisionConflict',
      message: 'Changed externally',
    })
    .mockResolvedValue(3);
  vi.mocked(audioClient.prepareSong).mockResolvedValue(ready);
  vi.mocked(audioClient.stop).mockResolvedValue(ready);
});

const note = (pitch: number) =>
  screen.getByRole('button', { name: tr('Нота {pitch}', { pitch }) });
const leaveWithSave = async () => {
  fireEvent.click(screen.getByRole('button', { name: tr('library') }));
  const dialog = await screen.findByRole('dialog', {
    name: tr('unsavedEditorTitle'),
  });
  fireEvent.click(within(dialog).getByRole('button', { name: tr('save') }));
};
const requestReload = async () => {
  render(
    <>
      <DialogView />
      <EditorPage />
    </>,
  );
  await screen.findByRole('button', {
    name: tr('Нота {pitch}', { pitch: 60 }),
  });
  await waitFor(() => expect(audioClient.prepareSong).toHaveBeenCalledOnce());
  fireEvent.keyDown(note(60), { key: 'ArrowUp' });
  await leaveWithSave();
  const conflict = await screen.findByRole('dialog', {
    name: tr('editorConflictTitle'),
  });
  fireEvent.click(
    within(conflict).getByRole('button', { name: tr('reloadLatest') }),
  );
};

it('keeps newer edits instead of applying a late conflict reload document', async () => {
  const loading = deferred<EditorDocument>();
  vi.mocked(editorApi.load).mockReturnValueOnce(loading.promise);
  await requestReload();
  await waitFor(() => expect(editorApi.load).toHaveBeenCalledTimes(2));
  fireEvent.keyDown(note(61), { key: 'ArrowUp' });

  await act(async () => loading.resolve(reloaded));

  expect
    .soft(
      screen.queryByRole('button', { name: tr('Нота {pitch}', { pitch: 62 }) }),
    )
    .toBeInTheDocument();
  expect(shell.navigate).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: tr('save') })).toBeEnabled();
  expect(editorApi.save).toHaveBeenCalledOnce();
});

it('keeps the editor open when edits arrive while conflict reload finishes', async () => {
  const preparing = deferred<PlaybackSnapshot>();
  vi.mocked(audioClient.prepareSong)
    .mockResolvedValueOnce(ready)
    .mockReturnValueOnce(preparing.promise);
  await requestReload();
  await screen.findByRole('button', {
    name: tr('Нота {pitch}', { pitch: 65 }),
  });
  fireEvent.keyDown(note(65), { key: 'ArrowUp' });

  await act(async () => preparing.resolve(ready));

  expect(shell.navigate).not.toHaveBeenCalled();
  expect(note(66)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: tr('save') })).toBeEnabled();
  await leaveWithSave();
  await waitFor(() =>
    expect(shell.navigate).toHaveBeenCalledExactlyOnceWith(routes.library),
  );
  expect(editorApi.save).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'song' }),
    expect.objectContaining({
      notes: [expect.objectContaining({ pitch: 66 })],
    }),
    2,
  );
});

it('still leaves after conflict reload when no additional edits were made', async () => {
  await requestReload();
  await waitFor(() =>
    expect(shell.navigate).toHaveBeenCalledExactlyOnceWith(routes.library),
  );
  expect(note(65)).toBeInTheDocument();
  expect(editorApi.save).toHaveBeenCalledOnce();
});

it('keeps original edits and supports retry when conflict reload fails', async () => {
  vi.mocked(editorApi.load).mockRejectedValueOnce(
    new Error('Disk unavailable'),
  );
  await requestReload();
  await waitFor(() =>
    expect(shell.notify).toHaveBeenCalledWith(tr('editorSaveFailed'), 'error'),
  );
  expect(note(61)).toBeInTheDocument();
  expect(shell.navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: tr('save') }));
  await waitFor(() => expect(editorApi.save).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled(),
  );
  expect(note(61)).toBeInTheDocument();
});
