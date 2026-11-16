import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSession, karaokeRecordingFixtureState } from './karaokeRecordingFixture';
import { useKaraokeSession } from './useKaraokeSession';
import { recordingCoordinator } from '../../services/recordingCoordinator';
import { pythonClient } from '../../services/pythonClient';
import { audioClient } from '../../services/audioClient';
import { usePositionPolling } from './usePositionPolling';
import { useAudioRecovery } from './useAudioRecovery';
import { useSynchronizedRoomPlayback } from './useSynchronizedRoomPlayback';
import { type ParticipantDto, type RoomStateDto } from '../../contracts/models';
const { roomState, monitoringPreference, monitoringWarning } =
  karaokeRecordingFixtureState;
describe('karaoke recording ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roomState.room = null;
    roomState.playbackEnabled = false;
    monitoringPreference.enabled = false;
    monitoringPreference.microphoneReady = true;
    vi.mocked(recordingCoordinator.start).mockResolvedValue({
      recording: true,
    });
    vi.mocked(recordingCoordinator.stop).mockResolvedValue({
      recording: false,
      recordingId: 'take',
    });
    vi.mocked(pythonClient.freeStorageBytes).mockResolvedValue(1e9);
  });

  afterEach(() => cleanup());

  it('reconfirms prepared room audio when readiness or selection changes', async () => {
    const self: ParticipantDto = {
      id: 'self',
      name: 'Me',
      role: 'participant',
      self: true,
      connected: true,
      muted: false,
      volume: 1,
      readiness: 'ready',
    };
    const selected: RoomStateDto = {
      code: 'room',
      hostId: 'host',
      role: 'participant',
      participants: [self],
      playbackLocked: false,
      playbackState: 'stopped',
      songId: 'song',
      revision: 1,
      selectionId: 1,
    };
    roomState.room = selected;
    roomState.playbackEnabled = true;
    const { result, rerender } = renderHook(() =>
      useKaraokeSession('song', 'RoomPrepared', true),
    );
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    await waitFor(() =>
      expect(roomState.playback.reportReady).toHaveBeenCalledTimes(1),
    );
    act(() => {
      roomState.room = { ...selected, playbackLocked: true };
      rerender();
    });
    expect(roomState.playback.reportReady).toHaveBeenCalledTimes(1);
    act(() => {
      roomState.room = {
        ...selected,
        participants: [{ ...self, readiness: 'audio' }],
      };
      rerender();
    });
    await waitFor(() =>
      expect(roomState.playback.reportReady).toHaveBeenCalledTimes(2),
    );
    act(() => {
      roomState.room = {
        ...selected,
        selectionId: 2,
        participants: [{ ...self, readiness: 'audio' }],
      };
      rerender();
    });
    await waitFor(() =>
      expect(roomState.playback.reportReady).toHaveBeenCalledTimes(3),
    );
  });

  it("does not stop the next route after an unmounted route's Play rejects", async () => {
    let rejectPlay: ((error: Error) => void) | undefined;
    vi.mocked(audioClient.play).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPlay = reject;
      }),
    );
    const previous = await startSession();
    await waitFor(() => expect(audioClient.play).toHaveBeenCalledOnce());
    previous.unmount();
    await waitFor(() =>
      expect(recordingCoordinator.stop).toHaveBeenCalledOnce(),
    );
    const next = await startSession();
    await waitFor(() => expect(next.result.current.state.kind).toBe('playing'));
    expect(audioClient.stop).toHaveBeenCalledOnce();

    await act(async () => {
      rejectPlay?.(new Error('old Play reply failed'));
    });

    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(audioClient.stop).toHaveBeenCalledOnce();
    expect(next.result.current.recording).toBe('recording');
  });

  it('does not resume a recovered session after its old Play resolves', async () => {
    let resolvePlay: (() => void) | undefined;
    vi.mocked(audioClient.play).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePlay = () => resolve(undefined as never);
      }),
    );
    const { result } = await startSession();
    await waitFor(() => expect(audioClient.play).toHaveBeenCalledOnce());
    act(() => {
      vi.mocked(usePositionPolling).mock.calls.at(-1)?.[0].onLost();
    });
    act(() => {
      vi.mocked(useAudioRecovery).mock.calls.at(-1)?.[0].onRecovered();
    });
    expect(result.current.state.kind).toBe('paused');

    await act(async () => {
      resolvePlay?.();
    });

    expect(result.current.state.kind).toBe('paused');
    expect(recordingCoordinator.stop).not.toHaveBeenCalled();
  });

  it.each(['Normal', 'Rehearsal'] as const)(
    'continues an interrupted %s performance after recovery',
    async (mode) => {
      const { result } = renderHook(() =>
        useKaraokeSession('song', mode, true),
      );
      if (mode === 'Normal') {
        await waitFor(() => expect(result.current.state.kind).toBe('ready'));
        await act(() => result.current.togglePlay());
      }
      await waitFor(() => expect(result.current.state.kind).toBe('playing'));
      act(() => {
        vi.mocked(usePositionPolling).mock.calls.at(-1)?.[0].onLost();
      });
      expect(result.current.state.kind).toBe('recovering');
      act(() => {
        vi.mocked(useAudioRecovery).mock.calls.at(-1)?.[0].onRecovered();
      });
      await waitFor(() => expect(result.current.state.kind).toBe('playing'));
      expect(audioClient.play).toHaveBeenCalledTimes(2);
      expect(recordingCoordinator.start).toHaveBeenCalledTimes(
        mode === 'Normal' ? 2 : 0,
      );
      expect(recordingCoordinator.interrupt).toHaveBeenCalledOnce();
    },
  );

  it('keeps a paused performance paused and starts a new recording only on Play', async () => {
    const { result } = await startSession();
    await waitFor(() => expect(result.current.state.kind).toBe('playing'));
    await act(() => result.current.togglePlay());
    expect(result.current.state.kind).toBe('paused');
    act(() => {
      vi.mocked(usePositionPolling).mock.calls.at(-1)?.[0].onLost();
    });
    act(() => {
      vi.mocked(useAudioRecovery).mock.calls.at(-1)?.[0].onRecovered();
    });
    expect(result.current.state.kind).toBe('paused');
    expect(audioClient.play).toHaveBeenCalledOnce();
    expect(recordingCoordinator.start).toHaveBeenCalledOnce();
    await act(() => result.current.togglePlay());
    expect(result.current.state.kind).toBe('playing');
    expect(recordingCoordinator.start).toHaveBeenCalledTimes(2);
  });

  it('does not resume a recovered room song as solo playback after leaving the room', async () => {
    roomState.room = {
      code: 'room',
      hostId: 'host',
      role: 'participant',
      participants: [],
      playbackLocked: false,
      playbackState: 'playing',
      songId: 'song',
      revision: 1,
    };
    const { result, rerender } = renderHook(() =>
      useKaraokeSession('song', 'RoomPrepared', true),
    );
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    act(() => {
      vi.mocked(useSynchronizedRoomPlayback)
        .mock.calls.at(-1)?.[0]
        .onEvent('PLAY');
    });
    await waitFor(() => expect(result.current.recording).toBe('recording'));
    act(() => {
      vi.mocked(usePositionPolling).mock.calls.at(-1)?.[0].onLost();
    });
    act(() => {
      vi.mocked(useAudioRecovery).mock.calls.at(-1)?.[0].onRecovered();
    });
    await act(async () => {
      roomState.room = null;
      rerender();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(audioClient.play).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe('finished');
  });

  it('does not unload the next route when old Play failure cleanup finishes saving', async () => {
    let finishSaving: (() => void) | undefined;
    vi.mocked(audioClient.play).mockRejectedValueOnce(new Error('Play failed'));
    vi.mocked(recordingCoordinator.stop).mockReturnValueOnce(
      new Promise((resolve) => {
        finishSaving = () =>
          resolve({ recording: false, recordingId: 'old-take' });
      }),
    );
    const previous = await startSession();
    await waitFor(() =>
      expect(recordingCoordinator.stop).toHaveBeenCalledOnce(),
    );
    previous.unmount();
    const next = renderHook(() =>
      useKaraokeSession('next-song', 'Normal', true),
    );
    await waitFor(() => expect(next.result.current.state.kind).toBe('ready'));
    expect(audioClient.stop).toHaveBeenCalledOnce();

    await act(async () => {
      finishSaving?.();
    });

    expect(audioClient.stop).toHaveBeenCalledOnce();
  });

  it('keeps the last monitoring intent when toggled twice before the driver responds', async () => {
    const { result } = renderHook(() =>
      useKaraokeSession('song', 'Normal', true),
    );
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    await act(async () => {
      await Promise.all([
        result.current.toggleMonitoring(),
        result.current.toggleMonitoring(),
      ]);
    });
    expect(
      vi
        .mocked(audioClient.setMonitoring)
        .mock.calls.map(([enabled]) => enabled),
    ).toEqual([true, false]);
    expect(result.current.monitoring).toBe(false);
  });

  it('restores the saved monitoring choice after leaving and opening another song', async () => {
    monitoringPreference.enabled = true;
    const first = renderHook(() => useKaraokeSession('song', 'Normal', true));
    await waitFor(() => expect(first.result.current.monitoring).toBe(true));
    expect(audioClient.setMonitoring).toHaveBeenLastCalledWith(true);
    first.unmount();
    expect(audioClient.setMonitoring).toHaveBeenLastCalledWith(false);

    const { result } = renderHook(() =>
      useKaraokeSession('next-song', 'Normal', true),
    );
    await waitFor(() => expect(result.current.monitoring).toBe(true));
    expect(audioClient.setMonitoring).toHaveBeenLastCalledWith(true);
  });

  it.each([false, true])(
    'keeps monitoring off without an enabled preference and ready microphone (%s)',
    async (enabled) => {
      monitoringPreference.enabled = enabled;
      monitoringPreference.microphoneReady = !enabled;
      const { result } = renderHook(() =>
        useKaraokeSession('song', 'Normal', true),
      );
      await waitFor(() => expect(result.current.state.kind).toBe('ready'));
      await waitFor(() =>
        expect(audioClient.setMixer).toHaveBeenCalledTimes(5),
      );
      expect(audioClient.setMonitoring).not.toHaveBeenCalledWith(true);
      expect(result.current.monitoring).toBe(false);
    },
  );

  it('does not fail karaoke or retry when restoring monitoring is rejected', async () => {
    monitoringPreference.enabled = true;
    vi.mocked(audioClient.setMonitoring).mockRejectedValueOnce(
      new Error('Monitoring unavailable'),
    );
    const { result, rerender } = renderHook(() =>
      useKaraokeSession('song', 'Normal', true),
    );
    await waitFor(() => expect(monitoringWarning).toHaveBeenCalledOnce());
    expect(result.current.state.kind).toBe('ready');
    expect(result.current.monitoring).toBe(false);
    rerender();
    expect(audioClient.setMonitoring).toHaveBeenCalledOnce();
  });

  it('shows one error when native monitoring protection disconnects the speaker', async () => {
    monitoringPreference.enabled = true;
    const { result, rerender } = renderHook(() =>
      useKaraokeSession('song', 'Normal', true),
    );
    await waitFor(() => expect(result.current.monitoring).toBe(true));
    const onSnapshot = vi
      .mocked(usePositionPolling)
      .mock.calls.at(-1)?.[0].onSnapshot;
    expect(onSnapshot).toBeDefined();
    const snapshot = {
      monitoring: false,
      monitoringSafetyTripped: true,
      pitchHz: undefined,
    } as never;
    act(() => {
      onSnapshot?.(snapshot);
      onSnapshot?.(snapshot);
    });
    expect(monitoringWarning).toHaveBeenCalledTimes(1);
    expect(monitoringWarning).toHaveBeenCalledWith(
      'Мониторинг микрофона отключён: входной сигнал долго оставался слишком громким. Уменьшите громкость колонок или используйте наушники перед повторным включением.',
      'error',
    );
    rerender();
    expect(result.current.monitoring).toBe(false);
    expect(audioClient.setMonitoring).toHaveBeenCalledOnce();
  });
});
