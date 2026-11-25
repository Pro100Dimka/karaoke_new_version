import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useRecordingPeaks, useWaveformPeaks } from './useWaveformPeaks';

const { waveformPeaks, recordingPeaks, cancelWaveform, sourcePeaks } =
  vi.hoisted(() => ({
    waveformPeaks: vi.fn(),
    recordingPeaks: vi.fn(),
    cancelWaveform: vi.fn(),
    sourcePeaks: vi.fn(),
  }));
vi.mock('../../services/desktopClient', () => ({
  desktopClient: { waveformPeaks, recordingPeaks, cancelWaveform },
}));
vi.mock('../../services/pythonClient', () => ({
  pythonClient: { songWaveformPeaks: sourcePeaks },
}));
vi.mock('../errors', () => ({
  reportOperationFailure: vi.fn(),
  clearOperationFailure: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  waveformPeaks.mockImplementation(() => new Promise(() => {}));
  recordingPeaks.mockImplementation(() => new Promise(() => {}));
  sourcePeaks.mockImplementation(() => new Promise(() => {}));
  cancelWaveform.mockResolvedValue(undefined);
});

it('cancels only the abandoned song request on replacement, disable and unmount', () => {
  const view = renderHook(
    ({ songId, enabled }) => useWaveformPeaks(songId, 0, enabled),
    {
      initialProps: { songId: 'first', enabled: true },
    },
  );
  const first = waveformPeaks.mock.calls[0]?.[3];
  expect(first).toEqual(expect.any(String));
  view.rerender({ songId: 'second', enabled: true });
  const second = waveformPeaks.mock.calls[1]?.[3];
  expect(second).not.toBe(first);
  expect(cancelWaveform).toHaveBeenCalledExactlyOnceWith(first);
  view.rerender({ songId: 'second', enabled: false });
  expect(cancelWaveform.mock.calls).toEqual([[first], [second]]);
  expect(waveformPeaks).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(cancelWaveform).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  'cancels a closed recording waveform, including original=%s',
  (original) => {
    const view = renderHook(() => useRecordingPeaks('take-or-song', original));
    const request = original ? waveformPeaks : recordingPeaks;
    const id = request.mock.calls[0]?.at(-1);
    expect(id).toEqual(expect.any(String));
    if (original)
      expect(request).toHaveBeenCalledWith('take-or-song', 0, 240, id);
    else expect(request).toHaveBeenCalledWith('take-or-song', 240, id);
    view.unmount();
    expect(cancelWaveform).toHaveBeenCalledExactlyOnceWith(id);
  },
);

it('does not cancel a completed request or replace fresh peaks with a late abandoned result', async () => {
  let finishOld!: (values: number[]) => void;
  waveformPeaks
    .mockImplementationOnce(
      () =>
        new Promise<number[]>((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce([1, 0.5]);
  const view = renderHook(({ songId }) => useWaveformPeaks(songId, 0), {
    initialProps: { songId: 'old' },
  });
  const oldId = waveformPeaks.mock.calls[0]?.[3];
  await act(async () => view.rerender({ songId: 'fresh' }));
  expect(view.result.current).toEqual([1, 0.5]);
  await act(async () => finishOld([0.1]));
  expect(view.result.current).toEqual([1, 0.5]);
  view.unmount();
  expect(cancelWaveform).toHaveBeenCalledExactlyOnceWith(oldId);
});
