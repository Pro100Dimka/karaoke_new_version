import { act, renderHook, waitFor } from '@testing-library/react';
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
    observeRecordingPreview: vi.fn(),
  },
}));
vi.mock('../../../../shared/errors', () => ({
  clearOperationFailure: vi.fn(),
  reportOperationFailure: vi.fn(),
  observeOperation: (_key: string, promise: Promise<unknown>) => promise,
}));

type Status = Awaited<ReturnType<typeof audioClient.recordingPreviewStatus>>;
const status: Status = {
  recordingId: 'take',
  state: 'playing',
  positionSeconds: 0,
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let telemetry: (value: Status) => void;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(audioClient.playRecording).mockResolvedValue({} as never);
  vi.mocked(audioClient.pauseRecordingPreview).mockResolvedValue(undefined);
  vi.mocked(audioClient.stopRecordingPreview).mockResolvedValue(undefined);
  vi.mocked(audioClient.seekRecordingPreview).mockResolvedValue(undefined);
  vi.mocked(audioClient.recordingPreviewStatus).mockResolvedValue(status);
  vi.mocked(audioClient.observeRecordingPreview).mockImplementation(
    (_owner, onValue) => {
      telemetry = onValue;
      return () => {};
    },
  );
});

it('collapses a scrub burst while status is pending and paints its newest position immediately', async () => {
  const held = deferred<Status>();
  const { result } = renderHook(() => useRecordingPlayback({ id: 'take' }));
  await act(() => result.current.toggle());
  vi.mocked(audioClient.recordingPreviewStatus).mockReturnValue(held.promise);
  const pending: Promise<void>[] = [];
  try {
    act(() => {
      for (let position = 1; position <= 100; position++)
        pending.push(result.current.seek(position));
    });
    expect(audioClient.recordingPreviewStatus).toHaveBeenCalledOnce();
    expect(result.current.position).toBe(100);
    act(() => telemetry({ ...status, positionSeconds: 0.1 }));
    expect(result.current.position).toBe(100);
  } finally {
    await act(async () => {
      held.resolve(status);
      await Promise.all(pending);
    });
  }
  expect(audioClient.seekRecordingPreview).toHaveBeenCalledExactlyOnceWith(
    100,
    expect.any(Symbol),
  );
  act(() => telemetry({ ...status, positionSeconds: 100.1 }));
  expect(result.current.position).toBe(100.1);
});

it('keeps only the latest waiting seek and completes it before a subsequent pause', async () => {
  const held = deferred<void>();
  const { result } = renderHook(() => useRecordingPlayback({ id: 'take' }));
  await act(() => result.current.toggle());
  vi.mocked(audioClient.seekRecordingPreview).mockReturnValueOnce(held.promise);
  const pending: Promise<void>[] = [];
  let pausing: Promise<void> | undefined;
  try {
    act(() => {
      pending.push(result.current.seek(1));
    });
    await waitFor(() =>
      expect(audioClient.seekRecordingPreview).toHaveBeenCalledOnce(),
    );
    act(() => {
      for (let position = 2; position <= 100; position++)
        pending.push(result.current.seek(position));
      pausing = result.current.toggle();
    });
    expect(result.current.position).toBe(100);
    expect(audioClient.pauseRecordingPreview).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      held.resolve();
      await Promise.all([...pending, pausing]);
    });
  }
  expect(
    vi
      .mocked(audioClient.seekRecordingPreview)
      .mock.calls.map(([value]) => value),
  ).toEqual([1, 100]);
  expect(audioClient.pauseRecordingPreview).toHaveBeenCalledOnce();
  expect(result.current.playing).toBe(false);
  expect(result.current.position).toBe(100);
});

it('retains the latest scrub made while the initial pending position is being applied', async () => {
  const held = deferred<void>();
  const { result } = renderHook(() => useRecordingPlayback({ id: 'take' }));
  await act(() => result.current.seek(20));
  vi.mocked(audioClient.seekRecordingPreview).mockReturnValueOnce(held.promise);
  let playing!: Promise<void>;
  const pending: Promise<void>[] = [];
  try {
    act(() => {
      playing = result.current.toggle();
    });
    await waitFor(() =>
      expect(audioClient.seekRecordingPreview).toHaveBeenCalledOnce(),
    );
    act(() => {
      for (let position = 21; position <= 100; position++)
        pending.push(result.current.seek(position));
    });
    expect(audioClient.recordingPreviewStatus).not.toHaveBeenCalled();
    expect(result.current.position).toBe(100);
  } finally {
    await act(async () => {
      held.resolve();
      await Promise.all([playing, ...pending]);
    });
  }
  expect(
    vi
      .mocked(audioClient.seekRecordingPreview)
      .mock.calls.map(([value]) => value),
  ).toEqual([20, 100]);
  expect(result.current.playing).toBe(true);
});

it.each(['unmount', 'replace'] as const)(
  'does not apply a buffered seek after %s',
  async (change) => {
    const held = deferred<Status>();
    const { result, unmount, rerender } = renderHook(
      ({ id }) => useRecordingPlayback({ id }),
      { initialProps: { id: 'take' } },
    );
    await act(() => result.current.toggle());
    vi.mocked(audioClient.recordingPreviewStatus).mockReturnValue(held.promise);
    const pending: Promise<void>[] = [];
    act(() => {
      pending.push(result.current.seek(10), result.current.seek(20));
    });
    if (change === 'unmount') unmount();
    else rerender({ id: 'replacement' });
    await act(async () => {
      held.resolve(status);
      await Promise.all(pending);
    });
    expect(audioClient.seekRecordingPreview).not.toHaveBeenCalled();
    expect(reportOperationFailure).not.toHaveBeenCalled();
    if (change === 'replace') expect(result.current.position).toBe(0);
  },
);

it('settles a failed burst once and allows a fresh gesture to retry', async () => {
  const held = deferred<Status>();
  const failure = new Error('Audio service is unavailable');
  const { result } = renderHook(() => useRecordingPlayback({ id: 'take' }));
  await act(() => result.current.toggle());
  vi.mocked(audioClient.recordingPreviewStatus).mockReturnValue(held.promise);
  const pending: Promise<void>[] = [];
  act(() => {
    for (let position = 1; position <= 100; position++)
      pending.push(result.current.seek(position));
  });
  await act(async () => {
    held.reject(failure);
    await Promise.all(pending);
  });
  expect(reportOperationFailure).toHaveBeenCalledExactlyOnceWith(
    'errors.previewSeek',
    failure,
  );
  expect(result.current.position).toBe(0);
  vi.mocked(audioClient.recordingPreviewStatus).mockResolvedValue(status);
  await act(() => result.current.seek(50));
  expect(audioClient.seekRecordingPreview).toHaveBeenCalledExactlyOnceWith(
    50,
    expect.any(Symbol),
  );
  expect(result.current.position).toBe(50);
});
