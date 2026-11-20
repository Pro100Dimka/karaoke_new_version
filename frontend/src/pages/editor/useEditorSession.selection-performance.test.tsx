import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EditorDocument } from '../../application/editor/editorModel';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { clearStorage } from '../../shared/storage/localStore';
import { editorApi } from './editorApi';
import { useEditorSession } from './useEditorSession';

vi.mock('../../providers/dialog', () => ({ ask: vi.fn() }));
vi.mock('../../providers/close-guards', () => ({ useCloseGuard: vi.fn() }));
vi.mock('../../providers/notifications', () => ({ useNotify: () => vi.fn() }));
vi.mock('../../services/pythonClient', () => ({
  pythonClient: { getSong: vi.fn(), projectCompatibility: vi.fn() },
}));
vi.mock('../../services/audioClient', () => ({
  audioClient: { prepareSong: vi.fn(), stop: vi.fn() },
}));
vi.mock('./editorApi', () => ({ editorApi: { load: vi.fn(), save: vi.fn() } }));

beforeEach(() => {
  vi.resetAllMocks();
  clearStorage();
  vi.mocked(pythonClient.getSong).mockResolvedValue({
    id: 'song',
    status: 'ready',
    activeRevision: 1,
  } as never);
  vi.mocked(pythonClient.projectCompatibility).mockResolvedValue('Current');
  vi.mocked(audioClient.prepareSong).mockResolvedValue({
    state: 'ready',
    positionSeconds: 0,
  } as never);
  vi.mocked(audioClient.stop).mockResolvedValue({} as never);
});
afterEach(() => vi.useRealTimers());

it.each([false, true])(
  'does not rebuild the full note ID set during 30 previews when selection near the start is %s',
  async (selected) => {
    let trailingIdReads = 0;
    const document: EditorDocument = {
      revision: 1,
      words: [],
      notes: Array.from({ length: 20_000 }, (_, index) => ({
        get id() {
          if (index > 0) trailingIdReads++;
          return `note-${index}`;
        },
        wordId: 'word',
        pitch: 60,
        start: index / 10,
        end: index / 10 + 0.05,
      })),
    };
    vi.mocked(editorApi.load).mockResolvedValue(document);
    const editor = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(editor.result.current.audioReady).toBe(true));
    if (selected) act(() => editor.result.current.select('note-0', false));
    const selection = editor.result.current.selection;
    trailingIdReads = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const start = performance.now();
    for (let update = 1; update <= 30; update++) {
      const notes = [...document.notes];
      notes[0] = { ...notes[0]!, pitch: 60 + update / 10 };
      act(() => editor.result.current.replacePresent({ ...document, notes }));
    }
    console.info(
      JSON.stringify({
        scenario: 'selection-prune-20000-notes-30-previews',
        selected,
        trailingIdReads,
        elapsedMs: performance.now() - start,
      }),
    );
    expect(editor.result.current.selection).toBe(selection);
    expect(trailingIdReads).toBe(0);
  },
);

it('prunes missing IDs in original selection order even when replacement notes keep the same count', async () => {
  const notes = ['first', 'middle', 'last'].map((id, index) => ({
    id,
    wordId: 'word',
    pitch: 60 + index,
    start: index,
    end: index + 0.5,
  }));
  const document: EditorDocument = { revision: 1, words: [], notes };
  vi.mocked(editorApi.load).mockResolvedValue(document);
  const editor = renderHook(() => useEditorSession('song'));
  await waitFor(() => expect(editor.result.current.audioReady).toBe(true));
  act(() =>
    editor.result.current.setSelection(
      new Set(['last', 'missing', 'first', 'middle']),
    ),
  );
  const next = {
    ...document,
    notes: [notes[0]!, { ...notes[1]!, id: 'replacement' }, notes[2]!],
  };
  act(() => editor.result.current.commit(document, next));
  expect([...editor.result.current.selection]).toEqual(['last', 'first']);
  const retained = editor.result.current.selection;
  act(() => editor.result.current.undo());
  expect(editor.result.current.selection).toBe(retained);
  act(() => editor.result.current.redo());
  expect(editor.result.current.selection).toBe(retained);
  act(() => editor.result.current.replacePresent({ ...next, notes: [] }));
  expect(editor.result.current.selection.size).toBe(0);
});
