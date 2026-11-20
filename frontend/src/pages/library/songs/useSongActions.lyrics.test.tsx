import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useSongActions } from './useSongActions';
import { pythonClient } from '../../../services/pythonClient';
import { editorApi } from '../../editor/editorApi';
import { ask } from '../../../providers/dialog';
import { refreshSongs } from '../../../components/api-service';

const effects = vi.hoisted(() => ({
  notify: vi.fn(),
  invalidate: vi.fn(async () => undefined),
}));
vi.mock('@neo-ui-kit/react', () => ({
  tr: (key: string, values?: unknown) =>
    key + (values ? JSON.stringify(values) : ''),
  useLocale: () => 'en',
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: effects.invalidate }),
}));
vi.mock('../../../components/api-service', () => ({
  refreshSongs: vi.fn(async () => undefined),
}));
vi.mock('../../../providers/store', () => ({ store: { application: {} } }));
vi.mock('../../../providers/dialog', () => ({ ask: vi.fn() }));
vi.mock('../../../providers/notifications', () => ({
  useNotify: () => effects.notify,
}));
vi.mock('../../../services/pythonClient', () => ({
  pythonClient: { processSong: vi.fn() },
}));
vi.mock('../../../services/audioClient', () => ({ audioClient: {} }));
vi.mock('../../../services/desktopClient', () => ({ desktopClient: {} }));
vi.mock('../../editor/editorApi', () => ({
  editorApi: { load: vi.fn(), reset: vi.fn() },
}));
vi.mock('./lastPlayed', () => ({ markPlayed: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pythonClient.processSong).mockResolvedValue({ id: 'job' } as never);
  vi.mocked(editorApi.load).mockResolvedValue({
    revision: 7,
    words: [],
    notes: [],
  });
  vi.mocked(editorApi.reset).mockResolvedValue(8);
  vi.mocked(ask).mockResolvedValue('reset');
});

it('retries the requested lyrics operation without starting a full reprocess', async () => {
  const { result } = renderHook(() => useSongActions());
  await act(async () => {
    expect(await result.current.retryProcessing('song', 'lyrics')).toBe(true);
  });
  expect(pythonClient.processSong).toHaveBeenCalledExactlyOnceWith(
    'song',
    'lyrics',
  );
  expect(editorApi.reset).not.toHaveBeenCalled();
});

it('waits for explicit confirmation, resets the exact loaded revision and starts lyrics once', async () => {
  let choose!: (choice: string) => void;
  vi.mocked(ask).mockReturnValueOnce(
    new Promise((resolve) => {
      choose = resolve;
    }),
  );
  const { result } = renderHook(() => useSongActions());
  let pending!: Promise<boolean>;
  act(() => {
    pending = result.current.resetLyricsAndReprocess('song');
  });
  await waitFor(() => expect(ask).toHaveBeenCalledOnce());
  expect(ask).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'resetLyricsTitle',
      body: 'resetLyricsBody{"revision":7}',
    }),
  );
  expect(editorApi.reset).not.toHaveBeenCalled();
  expect(pythonClient.processSong).not.toHaveBeenCalled();
  await act(async () => {
    expect(await result.current.resetLyricsAndReprocess('song')).toBe(false);
    choose('reset');
    expect(await pending).toBe(true);
  });
  expect(editorApi.reset).toHaveBeenCalledExactlyOnceWith('song', 7);
  expect(pythonClient.processSong).toHaveBeenCalledExactlyOnceWith(
    'song',
    'lyrics',
  );
  expect(vi.mocked(editorApi.reset).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(pythonClient.processSong).mock.invocationCallOrder[0] ?? 0,
  );
  expect(result.current.retrying).toBeNull();
});

it.each(['cancel', null])(
  'does not reset or process after confirmation is dismissed (%s)',
  async (choice) => {
    vi.mocked(ask).mockResolvedValueOnce(choice);
    const { result } = renderHook(() => useSongActions());
    await act(async () => {
      expect(await result.current.resetLyricsAndReprocess('song')).toBe(false);
    });
    expect(editorApi.reset).not.toHaveBeenCalled();
    expect(pythonClient.processSong).not.toHaveBeenCalled();
    expect(effects.notify).not.toHaveBeenCalled();
    expect(result.current.retrying).toBeNull();
  },
);

it('does not start a job if the confirmed revision changed before reset', async () => {
  vi.mocked(editorApi.reset).mockRejectedValueOnce({
    code: 'RevisionConflict',
    message: 'Song was edited while confirming',
    source: 'python',
  });
  const { result } = renderHook(() => useSongActions());
  await act(async () => {
    expect(await result.current.resetLyricsAndReprocess('song')).toBe(false);
  });
  expect(editorApi.reset).toHaveBeenCalledWith('song', 7);
  expect(pythonClient.processSong).not.toHaveBeenCalled();
  expect(effects.notify).toHaveBeenCalledWith(
    expect.stringContaining('Song was edited'),
    'error',
  );
});

it('keeps the backend cause when no usable AI baseline is available', async () => {
  vi.mocked(editorApi.reset).mockRejectedValueOnce({
    code: 'ArtifactNotFound',
    message: 'AI baseline is unavailable',
    source: 'python',
  });
  const { result } = renderHook(() => useSongActions());
  await act(async () => {
    expect(await result.current.resetLyricsAndReprocess('song')).toBe(false);
  });
  expect(pythonClient.processSong).not.toHaveBeenCalled();
  expect(effects.notify).toHaveBeenCalledWith(
    expect.stringContaining('AI baseline is unavailable'),
    'error',
  );
});

it('refreshes the restored revision even if the subsequent processing admission fails', async () => {
  vi.mocked(pythonClient.processSong).mockRejectedValueOnce(
    new Error('Resources unavailable'),
  );
  const { result } = renderHook(() => useSongActions());
  await act(async () => {
    expect(await result.current.resetLyricsAndReprocess('song')).toBe(false);
  });
  expect(editorApi.reset).toHaveBeenCalledWith('song', 7);
  expect(pythonClient.processSong).toHaveBeenCalledWith('song', 'lyrics');
  expect(refreshSongs).toHaveBeenCalled();
  expect(effects.notify).toHaveBeenCalledWith(
    expect.stringContaining('Resources unavailable'),
    'error',
  );
});
