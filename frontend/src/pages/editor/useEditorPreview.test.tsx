import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audioClient } from '../../services/audioClient';
import type { PlaybackSnapshot } from '../../contracts/models';
import { useEditorPreview } from './useEditorPreview';

vi.mock('../../services/audioClient', () => ({
  audioClient: {
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    observeSnapshots: vi.fn(),
  },
}));
let emit: (snapshot: PlaybackSnapshot) => void;
let stop: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(audioClient.play).mockResolvedValue({} as never);
  vi.mocked(audioClient.pause).mockResolvedValue({} as never);
  vi.mocked(audioClient.seek).mockImplementation(
    async (positionSeconds) => ({ positionSeconds }) as PlaybackSnapshot,
  );
  vi.mocked(audioClient.observeSnapshots).mockImplementation((onValue) => {
    emit = onValue;
    stop = vi.fn();
    return stop;
  });
});
describe('editor preview lifecycle', () => {
  it('uses authoritative notifications for playback and the seek result for a seek', async () => {
    const { result } = renderHook(() => useEditorPreview(true, vi.fn()));
    await act(() => result.current.togglePlay());
    expect(audioClient.play).toHaveBeenCalled();
    act(() =>
      emit({ positionSeconds: 12.5, state: 'playing' } as PlaybackSnapshot),
    );
    expect(result.current.position).toBe(12.5);
    await act(() => result.current.seek(7));
    expect(audioClient.seek).toHaveBeenCalledWith(7);
    expect(result.current.position).toBe(7);
  });
  it('releases the previous subscription when audio is replaced and can play again', async () => {
    const failed = vi.fn();
    const { result, rerender } = renderHook(
      ({ audioReady }) => useEditorPreview(audioReady, failed),
      { initialProps: { audioReady: true } },
    );
    await act(() => result.current.togglePlay());
    const previousStop = stop;
    rerender({ audioReady: false });
    expect(result.current.playing).toBe(false);
    expect(previousStop).toHaveBeenCalledOnce();
    rerender({ audioReady: true });
    await act(() => result.current.togglePlay());
    expect(audioClient.play).toHaveBeenCalledTimes(2);
    expect(audioClient.pause).not.toHaveBeenCalled();
  });
  it('subscribes only during playback and unsubscribes on pause and unmount', async () => {
    const { result, unmount } = renderHook(() =>
      useEditorPreview(true, vi.fn()),
    );
    expect(audioClient.observeSnapshots).not.toHaveBeenCalled();
    await act(() => result.current.togglePlay());
    const firstStop = stop;
    await act(() => result.current.togglePlay());
    expect(firstStop).toHaveBeenCalledOnce();
    await act(() => result.current.togglePlay());
    const secondStop = stop;
    unmount();
    expect(secondStop).toHaveBeenCalledOnce();
  });
});
