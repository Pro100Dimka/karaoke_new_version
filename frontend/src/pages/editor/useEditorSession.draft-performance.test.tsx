import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EditorDocument } from '../../application/editor/editorModel';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { reportOperationFailure } from '../../shared/errors';
import {
  clearStorage,
  readText,
  storageKey,
  writeText,
} from '../../shared/storage/localStore';
import { editorApi } from './editorApi';
import { loadDraft, saveDraft } from './editorDraft';
import { useEditorSession } from './useEditorSession';

vi.mock('../../providers/dialog', () => ({ ask: vi.fn(async () => null) }));
vi.mock('../../providers/close-guards', () => ({ useCloseGuard: vi.fn() }));
vi.mock('../../providers/notifications', () => ({ useNotify: () => vi.fn() }));
vi.mock('../../services/pythonClient', () => ({
  pythonClient: { getSong: vi.fn(), projectCompatibility: vi.fn() },
}));
vi.mock('../../services/audioClient', () => ({
  audioClient: { prepareSong: vi.fn(), stop: vi.fn() },
}));
vi.mock('./editorApi', () => ({ editorApi: { load: vi.fn(), save: vi.fn() } }));
vi.mock('../../shared/errors', async (original) => ({
  ...(await original<typeof import('../../shared/errors')>()),
  reportOperationFailure: vi.fn(),
}));

const saved: EditorDocument = {
  revision: 1,
  words: [{ id: 'word', text: 'Voice', start: 0, end: 5 }],
  notes: [
    {
      id: 'note',
      wordId: 'word',
      pitch: 60,
      start: 0,
      end: 1,
      contour: Array.from(
        { length: 512 },
        (_, i) => [i / 511, Math.sin(i), 1] as const,
      ),
    },
  ],
};
const changed = { ...saved, notes: [{ ...saved.notes[0]!, pitch: 61 }] };
const previous = {
  baseRevision: 1,
  document: { ...saved, notes: [{ ...saved.notes[0]!, pitch: 67 }] },
};
const draftKey = `${storageKey('editorDraft')}.song`;

beforeEach(() => {
  vi.clearAllMocks();
  clearStorage();
  vi.mocked(pythonClient.getSong).mockResolvedValue({
    id: 'song',
    status: 'ready',
    activeRevision: 1,
  } as never);
  vi.mocked(pythonClient.projectCompatibility).mockResolvedValue('Current');
  vi.mocked(editorApi.load).mockResolvedValue(saved);
  vi.mocked(audioClient.prepareSong).mockResolvedValue({
    state: 'ready',
    positionSeconds: 0,
  } as never);
  vi.mocked(audioClient.stop).mockResolvedValue({} as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const open = async () => {
  const editor = renderHook(() => useEditorSession('song'));
  await waitFor(() => expect(editor.result.current.audioReady).toBe(true));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return editor;
};
const previewAndAutosave = async (editor: Awaited<ReturnType<typeof open>>) => {
  act(() => editor.result.current.replacePresent(changed));
  await act(() => vi.advanceTimersByTimeAsync(600));
};

it('backs up and restores a previously validated draft without another full parse or serialization', async () => {
  saveDraft('song', previous);
  const raw = readText(draftKey);
  const editor = await open();
  const parse = vi.spyOn(JSON, 'parse');
  const stringify = vi.spyOn(JSON, 'stringify');
  await previewAndAutosave(editor);
  act(() => editor.result.current.replacePresent(saved));
  expect
    .soft(parse.mock.calls.filter(([value]) => value === raw))
    .toHaveLength(0);
  expect
    .soft(
      stringify.mock.calls.filter(
        ([value]) =>
          value && typeof value === 'object' && 'baseRevision' in value,
      ),
    )
    .toHaveLength(1);
  expect(readText(draftKey)).toBe(raw);
  expect(editor.result.current.dirty).toBe(false);
});

it('validates a changed external draft before capturing it and restores that newer draft', async () => {
  saveDraft('song', previous);
  const editor = await open();
  const external = {
    ...previous,
    document: {
      ...previous.document,
      notes: [{ ...previous.document.notes[0]!, pitch: 69 }],
    },
  };
  const raw = JSON.stringify(external);
  writeText(draftKey, raw);
  const parse = vi.spyOn(JSON, 'parse');
  await previewAndAutosave(editor);
  act(() => editor.result.current.replacePresent(saved));
  expect(parse.mock.calls.filter(([value]) => value === raw)).toHaveLength(1);
  expect(readText(draftKey)).toBe(raw);
});

it.each([
  '{broken',
  JSON.stringify({ baseRevision: 1, document: { words: {}, notes: [] } }),
])('does not restore an invalid external draft: %s', async (raw) => {
  saveDraft('song', previous);
  const editor = await open();
  writeText(draftKey, raw);
  await previewAndAutosave(editor);
  act(() => editor.result.current.replacePresent(saved));
  expect(readText(draftKey)).toBeNull();
  if (raw === '{broken')
    expect(reportOperationFailure).toHaveBeenCalledWith(
      'errors.storageRead',
      expect.any(Error),
    );
});

it('keeps the storage read failure contract when a backup cannot be read', async () => {
  const editor = await open();
  const failure = new Error('Read blocked');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
    throw failure;
  });
  await previewAndAutosave(editor);
  expect(reportOperationFailure).toHaveBeenCalledWith(
    'errors.storageRead',
    failure,
  );
  act(() => editor.result.current.replacePresent(saved));
  expect(readText(draftKey)).toBeNull();
});

it('reports a failed checkpoint restore without throwing away the still-stored newer draft', async () => {
  saveDraft('song', previous);
  const editor = await open();
  await previewAndAutosave(editor);
  const failure = new Error('Write blocked');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw failure;
  });
  expect(() =>
    act(() => editor.result.current.replacePresent(saved)),
  ).not.toThrow();
  expect(reportOperationFailure).toHaveBeenCalledWith(
    'errors.storageWrite',
    failure,
  );
  expect(loadDraft('song')?.document.notes[0]?.pitch).toBe(61);
});

it('still returns independently parsed document objects when a caller loads a draft twice', () => {
  saveDraft('song', previous);
  const first = loadDraft('song')!;
  first.document.notes[0]!.pitch = 90;
  const second = loadDraft('song')!;
  expect(second).not.toBe(first);
  expect(second.document.notes[0]?.pitch).toBe(67);
});
