import {
  act,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioClient } from '../../services/audioClient';
import { pythonClient } from '../../services/pythonClient';
import { clearStorage } from '../../shared/storage/localStore';
import { useEditorSession } from './useEditorSession';
import type { EditorDocument } from '../../application/editor/editorModel';
import { loadDraft } from './editorDraft';
import { EditorPage } from './index';

vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => ({ params: { songId: 'song' }, navigate: vi.fn() }),
}));
vi.mock('./EditorPianoRoll', () => ({
  EditorPianoRoll: ({
    document,
    onSelect,
  }: {
    document: EditorDocument;
    onSelect(id: string, additive: boolean): void;
  }) => (
    <button data-testid="notes" onClick={() => onSelect('note', false)}>
      {document.notes.length}
    </button>
  ),
}));
vi.mock('./EditorHeader', () => ({ EditorHeader: () => null }));
vi.mock('./EditorTransport', () => ({ EditorTransport: () => null }));

const dialogs = vi.hoisted(() => ({
  ask: vi.fn(),
  notify: vi.fn(),
  text: (key: string) => key,
}));

vi.mock('../../providers/dialog', () => ({ ask: dialogs.ask }));
vi.mock('../../providers/close-guards', () => ({ useCloseGuard: vi.fn() }));
vi.mock('../../providers/notifications', () => ({
  useNotify: () => dialogs.notify,
}));

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
    snapshot: vi.fn(),
    observeSnapshots: vi.fn(),
  },
  getAudioSnapshot: vi.fn(),
}));
const editorApi = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('./editorApi', () => ({ editorApi }));

const document: EditorDocument = {
  revision: 1,
  words: [{ id: 'word', text: 'Voice', start: 0, end: 2 }],
  notes: [{ id: 'note', wordId: 'word', pitch: 60, start: 0, end: 1 }],
};

describe('editor session', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.resetAllMocks();
    dialogs.text = (key: string) => key;
    clearStorage();
    vi.mocked(pythonClient.getSong).mockImplementation(
      async (id) => ({ id, status: 'ready', activeRevision: 1 }) as never,
    );
    vi.mocked(pythonClient.projectCompatibility).mockResolvedValue('Current');
    vi.mocked(editorApi.load).mockResolvedValue(document);
    vi.mocked(audioClient.prepareSong).mockResolvedValue({
      state: 'ready',
      positionSeconds: 0,
    } as never);
    vi.mocked(audioClient.observeSnapshots).mockReturnValue(vi.fn());
    vi.mocked(audioClient.stop).mockResolvedValue({} as never);
    vi.mocked(audioClient.play).mockResolvedValue({} as never);
  });

  it.each(['paused', 'playing'] as const)(
    'reloads the saved guide and preserves a %s preview at the current position',
    async (state) => {
      editorApi.save.mockResolvedValue(2);
      const { result } = renderHook(() => useEditorSession('song'));
      await waitFor(() => expect(result.current.audioReady).toBe(true));
      vi.mocked(audioClient.prepareSong).mockResolvedValue({
        state,
        positionSeconds: 27.25,
      } as never);
      act(() => result.current.move(new Set(['note']), 12, 0));
      await act(async () => expect(await result.current.save()).toBe(true));

      expect(audioClient.prepareSong).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'song', activeRevision: 2 }),
        expect.any(Function),
        { preservePlayback: true },
      );
      expect(result.current.load).toMatchObject({
        kind: 'ready',
        song: { activeRevision: 2 },
      });
      expect(result.current.position).toBe(27.25);
      expect(result.current.playing).toBe(state === 'playing');
      expect(audioClient.play).not.toHaveBeenCalled();
    },
  );

  it('keeps the prepared guide for word-only saves', async () => {
    editorApi.save.mockResolvedValue(2);
    const { result } = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    act(() =>
      result.current.commit(document, {
        ...document,
        words: [{ ...document.words[0]!, text: 'Corrected' }],
      }),
    );
    await act(async () => expect(await result.current.save()).toBe(true));
    expect(audioClient.prepareSong).toHaveBeenCalledTimes(1);
    expect(result.current.load).toMatchObject({ song: { activeRevision: 2 } });
  });

  it('keeps a successful save when refreshing its audio fails', async () => {
    editorApi.save.mockResolvedValue(2);
    const { result } = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    vi.mocked(audioClient.prepareSong).mockRejectedValue(
      new Error('Audio unavailable'),
    );
    act(() => result.current.move(new Set(['note']), 12, 0));
    await act(async () => expect(await result.current.save()).toBe(true));
    expect(result.current.document?.revision).toBe(2);
    expect(result.current.dirty).toBe(false);
    expect(result.current.audioReady).toBe(false);
    expect(dialogs.notify).not.toHaveBeenCalledWith(
      'editorSaveFailed',
      'error',
    );
  });

  it('recovers a failed preview refresh on the next save without losing its restored position', async () => {
    editorApi.save.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    const { result } = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    vi.mocked(audioClient.prepareSong).mockRejectedValueOnce(
      new Error('Audio unavailable'),
    );
    act(() => result.current.move(new Set(['note']), 12, 0));
    await act(async () => expect(await result.current.save()).toBe(true));
    expect(result.current.audioReady).toBe(false);

    vi.mocked(audioClient.prepareSong).mockResolvedValue({
      state: 'paused',
      positionSeconds: 27.25,
    } as never);
    await act(async () => expect(await result.current.save()).toBe(true));
    expect(result.current.audioReady).toBe(true);
    expect(result.current.position).toBe(27.25);
    expect(result.current.playing).toBe(false);
    expect(audioClient.prepareSong).toHaveBeenCalledTimes(3);
    expect(editorApi.save).toHaveBeenCalledTimes(1);
    expect(result.current.document?.revision).toBe(2);
  });

  it('disables playback while preparing a different song in the same session', async () => {
    let finishSecondPreparation!: () => void;
    vi.mocked(audioClient.prepareSong)
      .mockResolvedValueOnce({} as never)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecondPreparation = () => resolve({} as never);
          }),
      );

    const { result, rerender } = renderHook(
      ({ songId }) => useEditorSession(songId),
      { initialProps: { songId: 'first' } },
    );
    await waitFor(() => expect(result.current.audioReady).toBe(true));

    rerender({ songId: 'second' });
    await waitFor(() =>
      expect(audioClient.prepareSong).toHaveBeenCalledTimes(2),
    );
    expect(result.current.audioReady).toBe(false);
    await act(async () => result.current.togglePlay());
    expect(audioClient.play).not.toHaveBeenCalled();

    await act(async () => finishSecondPreparation());
    expect(result.current.audioReady).toBe(true);
  });

  it('preserves edits made while saving and saves them against the returned revision', async () => {
    let finishSave!: (revision: number) => void;
    editorApi.save
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            finishSave = resolve;
          }),
      )
      .mockResolvedValueOnce(3);
    const { result } = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    act(() => result.current.move(new Set(['note']), 1, 0));
    let saving!: Promise<boolean>;
    act(() => {
      saving = result.current.save();
    });
    act(() => result.current.move(new Set(['note']), 1, 0));
    await act(async () => {
      finishSave(2);
      await saving;
    });

    expect(result.current.document?.notes[0]?.pitch).toBe(62);
    expect(result.current.document?.revision).toBe(2);
    expect(result.current.dirty).toBe(true);
    expect(await saving).toBe(false);
    expect(loadDraft('song')).toMatchObject({
      baseRevision: 2,
      document: { notes: [{ pitch: 62 }] },
    });
    await act(async () => {
      await result.current.save();
    });
    expect(editorApi.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'song' }),
      expect.objectContaining({
        notes: [expect.objectContaining({ pitch: 62 })],
      }),
      2,
    );
    expect(result.current.dirty).toBe(false);
    expect(loadDraft('song')).toBeNull();
  });

  it('does not submit a second save while the first save is pending', async () => {
    let finishSave!: (revision: number) => void;
    editorApi.save.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finishSave = resolve;
        }),
    );
    const { result } = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    act(() => result.current.move(new Set(['note']), 1, 0));
    let saving!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      saving = result.current.save();
      duplicate = result.current.save();
    });
    expect(editorApi.save).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishSave(2);
      await saving;
    });
    expect(await duplicate).toBe(true);
    expect(result.current.saving).toBe(false);
  });

  it('finishes Save and leave when the already running save succeeds', async () => {
    let finishSave!: (revision: number) => void;
    editorApi.save.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finishSave = resolve;
        }),
    );
    dialogs.ask.mockResolvedValue('save');
    const { result } = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    act(() => result.current.move(new Set(['note']), 1, 0));
    let saving!: Promise<boolean>;
    let leaving!: Promise<boolean>;
    act(() => {
      saving = result.current.save();
    });
    await act(async () => {
      leaving = result.current.resolveUnsaved();
    });
    await act(async () => {
      finishSave(2);
      await saving;
    });

    expect(await leaving).toBe(true);
    expect(editorApi.save).toHaveBeenCalledTimes(1);
    expect(result.current.dirty).toBe(false);
  });

  it('does not recreate discarded edits while another close guard keeps the editor open', async () => {
    dialogs.ask.mockResolvedValue('discard');
    const { result } = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.move(new Set(['note']), 1, 0));
    await act(async () =>
      expect(await result.current.resolveUnsaved()).toBe(true),
    );
    // App shutdown may still be waiting for processing to stop, or be cancelled there.
    await act(() => vi.advanceTimersByTimeAsync(600));

    expect(loadDraft('song')).toBeNull();
    expect(result.current.document).toEqual(document);
    expect(result.current.dirty).toBe(false);
    expect(editorApi.save).not.toHaveBeenCalled();
  });

  it('discards only later edits after an already submitted save finishes', async () => {
    let finishSave!: (revision: number) => void;
    editorApi.save.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finishSave = resolve;
        }),
    );
    dialogs.ask.mockResolvedValue('discard');
    const { result } = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    act(() => result.current.move(new Set(['note']), 1, 0));
    let saving!: Promise<boolean>;
    let leaving!: Promise<boolean>;
    act(() => {
      saving = result.current.save();
    });
    act(() => result.current.move(new Set(['note']), 1, 0));
    await act(async () => {
      leaving = result.current.resolveUnsaved();
    });
    await act(async () => {
      finishSave(2);
      await saving;
      await leaving;
    });

    expect(await leaving).toBe(true);
    expect(result.current.document).toMatchObject({
      revision: 2,
      notes: [{ pitch: 61 }],
    });
    expect(result.current.dirty).toBe(false);
    expect(loadDraft('song')).toBeNull();
    expect(editorApi.save).toHaveBeenCalledTimes(1);
  });

  it('does not replace the next song with a late save response', async () => {
    let finishSave!: (revision: number) => void;
    editorApi.save.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finishSave = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ songId }) => useEditorSession(songId),
      { initialProps: { songId: 'first' } },
    );
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    act(() => result.current.move(new Set(['note']), 1, 0));
    let saving!: Promise<boolean>;
    act(() => {
      saving = result.current.save();
    });
    const second = { ...document, revision: 10, lyrics: 'Second song' };
    editorApi.load.mockResolvedValueOnce(second);
    rerender({ songId: 'second' });
    await waitFor(() => expect(result.current.document).toEqual(second));
    await act(async () => {
      finishSave(2);
      await saving;
    });

    expect(result.current.document).toEqual(second);
    expect(result.current.dirty).toBe(false);
    expect(result.current.saving).toBe(false);
    expect(dialogs.notify).not.toHaveBeenCalled();
  });

  it('removes a recovery draft after undo returns to the saved document', async () => {
    const { result } = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    vi.useFakeTimers();
    act(() => result.current.move(new Set(['note']), 1, 0));
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(loadDraft('song')).not.toBeNull();

    act(() => result.current.undo());
    expect(result.current.dirty).toBe(false);
    expect(loadDraft('song')).toBeNull();
  });

  it.each(['cancel', 'reload', 'overwrite'])(
    'handles a revision conflict with %s',
    async (choice) => {
      editorApi.save
        .mockRejectedValueOnce({
          code: 'RevisionConflict',
          message: 'Changed externally',
        })
        .mockResolvedValueOnce(11);
      dialogs.ask.mockResolvedValueOnce(choice);
      const { result } = renderHook(() => useEditorSession('song'));
      await waitFor(() => expect(result.current.audioReady).toBe(true));
      act(() => result.current.move(new Set(['note']), 1, 0));
      editorApi.load.mockResolvedValueOnce({ ...document, revision: 10 });
      let saved = false;
      await act(async () => {
        saved = await result.current.save();
      });

      expect(saved).toBe(choice !== 'cancel');
      expect(result.current.dirty).toBe(choice === 'cancel');
      expect(result.current.document?.notes[0]?.pitch).toBe(
        choice === 'reload' ? 60 : 61,
      );
      expect(editorApi.save).toHaveBeenCalledTimes(
        choice === 'overwrite' ? 2 : 1,
      );
      if (choice === 'overwrite')
        expect(editorApi.save.mock.lastCall?.[2]).toBe(10);
    },
  );

  it('keeps edits after a failed save and allows retry', async () => {
    editorApi.save
      .mockRejectedValueOnce(new Error('Disk full'))
      .mockResolvedValueOnce(2);
    const { result } = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    act(() => result.current.move(new Set(['note']), 1, 0));
    await act(async () => {
      expect(await result.current.save()).toBe(false);
    });
    expect(result.current.document?.notes[0]?.pitch).toBe(61);
    expect(result.current.dirty).toBe(true);
    expect(result.current.saving).toBe(false);
    await act(async () => {
      expect(await result.current.save()).toBe(true);
    });
    expect(result.current.dirty).toBe(false);
  });

  it('keeps unsaved edits when the application language changes', async () => {
    const { result, rerender } = renderHook(() => useEditorSession('song'));
    await waitFor(() => expect(result.current.audioReady).toBe(true));
    act(() => result.current.move(new Set(['note']), 1, 0));

    dialogs.text = (key: string) => `translated:${key}`;
    await act(async () => {
      rerender();
    });

    expect(result.current.document?.notes[0]?.pitch).toBe(61);
    expect(result.current.dirty).toBe(true);
    expect(editorApi.load).toHaveBeenCalledTimes(1);
    expect(audioClient.stop).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'menu', 'editable', 'handled'])(
    'leaves editor shortcuts to %s, then restores them',
    async (owner) => {
      const view = render(<EditorPage />);
      const notes = await view.findByTestId('notes');
      fireEvent.click(notes);
      const overlay = window.document.createElement(
        owner === 'dialog' ? 'dialog' : 'div',
      );
      if (owner === 'dialog') overlay.setAttribute('open', '');
      if (owner === 'menu') overlay.setAttribute('role', 'menu');
      if (owner === 'editable') overlay.setAttribute('contenteditable', 'true');
      const cancel = window.document.createElement('button');
      overlay.append(cancel);
      window.document.body.append(overlay);
      try {
        const event = new KeyboardEvent('keydown', {
          key: 'Delete',
          bubbles: true,
          cancelable: true,
        });
        if (owner === 'handled') event.preventDefault();
        fireEvent(cancel, event);
        expect(notes.textContent).toBe('1');
      } finally {
        overlay.remove();
      }
      fireEvent.keyDown(view.getByRole('main'), { key: 'Delete' });
      expect(notes.textContent).toBe('0');
    },
  );
});
