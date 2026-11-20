import { addMessages, setLocale, tr } from '@neo-ui-kit/react';
import {
  act,
  fireEvent,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EditorDocument } from '../../application/editor/editorModel';
import { DialogView } from '../../providers/dialog';
import { en } from '../../providers/localization/messages.en';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { clearStorage } from '../../shared/storage/localStore';
import { editorApi } from './editorApi';
import { loadDraft, saveDraft } from './editorDraft';
import { useEditorSession } from './useEditorSession';

vi.mock('../../providers/close-guards', () => ({ useCloseGuard: vi.fn() }));
vi.mock('../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../services/pythonClient', () => ({
  pythonClient: { getSong: vi.fn(), projectCompatibility: vi.fn() },
}));
vi.mock('../../services/audioClient', () => ({
  audioClient: { prepareSong: vi.fn(), stop: vi.fn() },
}));
vi.mock('./editorApi', () => ({
  editorApi: { load: vi.fn(), save: vi.fn() },
}));

const saved: EditorDocument = {
  revision: 1,
  words: [{ id: 'word', text: 'Original', start: 0, end: 2 }],
  notes: [{ id: 'note', wordId: 'word', pitch: 60, start: 0, end: 1 }],
};
const recovered: EditorDocument = {
  ...saved,
  words: [{ ...saved.words[0]!, text: 'Corrected lyrics' }],
  notes: [{ ...saved.notes[0]!, pitch: 64 }],
};
const draft = { baseRevision: saved.revision, document: recovered };

beforeEach(() => {
  vi.resetAllMocks();
  clearStorage();
  addMessages('en', en);
  setLocale('en');
  vi.mocked(pythonClient.getSong).mockResolvedValue({
    id: 'song',
    title: 'Song',
    artist: 'Singer',
    status: 'ready',
    language: 'English',
    durationSeconds: 10,
    createdAt: '2026-11-20T00:00:00Z',
    coverState: 'Fallback',
    activeRevision: 1,
    projectFormatVersion: 1,
  });
  vi.mocked(pythonClient.projectCompatibility).mockResolvedValue('Current');
  vi.mocked(editorApi.load).mockResolvedValue(saved);
  vi.mocked(audioClient.prepareSong).mockResolvedValue({} as never);
  vi.mocked(audioClient.stop).mockResolvedValue({} as never);
  saveDraft('song', draft);
});
afterEach(() => vi.useRealTimers());

const WithDialog = ({ children }: PropsWithChildren) => (
  <>
    {children}
    <DialogView />
  </>
);
const openEditor = () =>
  renderHook(() => useEditorSession('song'), { wrapper: WithDialog });
const recoveryDialog = () =>
  screen.findByRole('dialog', { name: tr('draftFoundTitle') });

it.each(['close button', 'Escape cancellation'] as const)(
  'keeps the recovery draft after %s and offers it when the editor reopens',
  async (dismissal) => {
    const first = openEditor();
    const dialog = await recoveryDialog();
    if (dismissal === 'close button')
      fireEvent.click(
        within(dialog).getByRole('button', { name: tr('close') }),
      );
    else {
      fireEvent.keyDown(dialog, { key: 'Escape' });
      // Browsers emit cancel for Escape; jsdom requires the native event explicitly.
      fireEvent(dialog, new Event('cancel', { cancelable: true }));
    }
    await waitFor(() => expect(first.result.current.audioReady).toBe(true));

    expect(loadDraft('song')).toEqual(draft);
    expect(first.result.current.document).toEqual(saved);
    expect(first.result.current.dirty).toBe(false);
    first.unmount();

    const reopened = openEditor();
    const recovery = await recoveryDialog();
    fireEvent.click(
      within(recovery).getByRole('button', { name: tr('restoreDraft') }),
    );
    await waitFor(() => expect(reopened.result.current.dirty).toBe(true));
    expect(reopened.result.current.document).toEqual(recovered);
    expect(loadDraft('song')).toEqual(draft);
    expect(editorApi.save).not.toHaveBeenCalled();
  },
);

it('deletes a recovery draft only after the explicit discard action', async () => {
  const first = openEditor();
  const dialog = await recoveryDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: tr('discard') }));
  await waitFor(() => expect(first.result.current.audioReady).toBe(true));

  expect(loadDraft('song')).toBeNull();
  expect(first.result.current.document).toEqual(saved);
  expect(first.result.current.dirty).toBe(false);
  first.unmount();

  const reopened = openEditor();
  await waitFor(() => expect(reopened.result.current.audioReady).toBe(true));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(reopened.result.current.document).toEqual(saved);
  expect(editorApi.save).not.toHaveBeenCalled();
});

it('restores the saved text and notes when restoration is explicitly chosen', async () => {
  const editor = openEditor();
  const dialog = await recoveryDialog();
  fireEvent.click(
    within(dialog).getByRole('button', { name: tr('restoreDraft') }),
  );
  await waitFor(() => expect(editor.result.current.dirty).toBe(true));

  expect(editor.result.current.document).toEqual(recovered);
  expect(loadDraft('song')).toEqual(draft);
  expect(editorApi.save).not.toHaveBeenCalled();
});

it('does not resurrect an earlier recovery draft after later edits are explicitly discarded', async () => {
  const editor = openEditor();
  const recovery = await recoveryDialog();
  fireEvent.click(within(recovery).getByRole('button', { name: tr('close') }));
  await waitFor(() => expect(editor.result.current.audioReady).toBe(true));
  vi.useFakeTimers();
  act(() => editor.result.current.move(new Set(['note']), 1, 0));
  await act(() => vi.advanceTimersByTimeAsync(600));
  expect(loadDraft('song')?.document.notes[0]?.pitch).toBe(61);
  let leaving!: Promise<boolean>;
  act(() => {
    leaving = editor.result.current.resolveUnsaved();
  });
  const confirmation = screen.getByRole('dialog', {
    name: tr('unsavedEditorTitle'),
  });
  fireEvent.click(
    within(confirmation).getByRole('button', { name: tr('discardChanges') }),
  );
  await act(async () => expect(await leaving).toBe(true));

  expect(editor.result.current.document).toEqual(saved);
  expect(editor.result.current.dirty).toBe(false);
  expect(loadDraft('song')).toBeNull();
});
