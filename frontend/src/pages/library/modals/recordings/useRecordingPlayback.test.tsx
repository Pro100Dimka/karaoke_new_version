import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { audioClient } from '../../../../services/audioClient';
import { reportOperationFailure } from '../../../../shared/errors';
import { useRecordingPlayback } from './useRecordingPlayback';

vi.mock('../../../../services/audioClient', () => ({
  audioClient: {
    playRecording: vi.fn(),
    pauseRecordingPreview: vi.fn(),
    seekRecordingPreview: vi.fn(),
    stopRecordingPreview: vi.fn(),
    recordingPreviewStatus: vi.fn(),
    observeRecordingPreview: vi.fn(() => () => {}),
  },
}));
vi.mock('../../../../shared/errors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/errors')>()),
  clearOperationFailure: vi.fn(),
  reportOperationFailure: vi.fn(),
  observeOperation: (_key: string, promise: Promise<unknown>) => promise,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(audioClient.playRecording).mockResolvedValue({} as never);
  vi.mocked(audioClient.pauseRecordingPreview).mockResolvedValue(undefined);
  vi.mocked(audioClient.stopRecordingPreview).mockResolvedValue(undefined);
  vi.mocked(audioClient.seekRecordingPreview).mockResolvedValue(undefined);
  vi.mocked(audioClient.recordingPreviewStatus).mockResolvedValue({
    recordingId: 'take',
    state: 'playing',
    positionSeconds: 0,
  });
});

it('reports an unavailable preview status without rejecting an unobserved waveform action', async () => {
  const failure = new Error('Audio service disconnected');
  const { result } = renderHook(() => useRecordingPlayback({ id: 'take' }));
  await act(() => result.current.toggle());
  vi.mocked(audioClient.recordingPreviewStatus).mockRejectedValueOnce(failure);
  await act(async () => {
    await expect(result.current.seek(20)).resolves.toBeUndefined();
  });
  expect(reportOperationFailure).toHaveBeenCalledWith(
    'errors.previewSeek',
    failure,
  );
});

it('stops the audible preview if applying the initial waveform position fails', async () => {
  const failure = new Error('Seek rejected');
  const { result } = renderHook(() => useRecordingPlayback({ id: 'take' }));
  await act(() => result.current.seek(20));
  vi.mocked(audioClient.seekRecordingPreview).mockRejectedValueOnce(failure);
  await act(() => result.current.toggle());

  expect(result.current.playing).toBe(false);
  expect(audioClient.stopRecordingPreview).toHaveBeenCalledWith(
    expect.any(Symbol),
  );
  expect(reportOperationFailure).toHaveBeenCalledWith(
    'errors.previewPlayback',
    failure,
  );
});

it('keeps the pending preview owned when seeking before it finishes loading', async () => {
  let finishLoading!: () => void;
  vi.mocked(audioClient.playRecording).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLoading = () => resolve({} as never);
      }),
  );
  vi.mocked(audioClient.recordingPreviewStatus).mockResolvedValue({
    recordingId: null,
    state: 'ready',
    positionSeconds: 0,
  });
  const { result, unmount } = renderHook(() =>
    useRecordingPlayback({ id: 'take' }),
  );
  let loading!: Promise<void>;
  act(() => {
    loading = result.current.toggle();
  });
  await act(() => result.current.seek(20));
  unmount();
  expect(audioClient.stopRecordingPreview).toHaveBeenCalledWith(
    expect.any(Symbol),
  );
  await act(async () => {
    finishLoading();
    await loading;
  });
  expect(audioClient.seekRecordingPreview).not.toHaveBeenCalled();
});

it('can pause a preview that was positioned while it was still loading', async () => {
  let finishLoading!: () => void;
  vi.mocked(audioClient.playRecording).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLoading = () => resolve({} as never);
      }),
  );
  vi.mocked(audioClient.recordingPreviewStatus).mockResolvedValue({
    recordingId: null,
    state: 'ready',
    positionSeconds: 0,
  });
  const { result } = renderHook(() => useRecordingPlayback({ id: 'take' }));
  let loading!: Promise<void>;
  act(() => {
    loading = result.current.toggle();
  });
  await act(() => result.current.seek(20));
  await act(async () => {
    finishLoading();
    await loading;
  });
  expect(audioClient.seekRecordingPreview).toHaveBeenCalledWith(
    20,
    expect.any(Symbol),
  );
  expect(result.current.playing).toBe(true);

  await act(() => result.current.toggle());
  expect(audioClient.pauseRecordingPreview).toHaveBeenCalledOnce();
  expect(audioClient.playRecording).toHaveBeenCalledOnce();
  expect(result.current.playing).toBe(false);
});
