import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startSession,
  karaokeRecordingFixtureState,
} from './karaokeRecordingFixture';
import { useKaraokeSession } from './useKaraokeSession';
import { recordingCoordinator } from '../../services/recordingCoordinator';
import { pythonClient } from '../../services/pythonClient';
import { audioClient } from '../../services/audioClient';
import { usePositionPolling } from './usePositionPolling';
import { useAudioRecovery } from './useAudioRecovery';
import { store } from '../../providers/store';
import { useRoomPlayback } from '../../providers/application';
import { useKaraokeRecording } from './useKaraokeRecording';
import type { RoomStateDto, SongDto } from '../../contracts/models';
const { dialogs, roomState, monitoringPreference } =
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

  it('starts rehearsal without allocating or starting a recording', async () => {
    const { result } = renderHook(() =>
      useKaraokeSession('song', 'Rehearsal' as never, true),
    );
    await waitFor(() => expect(result.current.state.kind).toBe('playing'));
    expect(recordingCoordinator.start).not.toHaveBeenCalled();
    expect(audioClient.play).toHaveBeenCalledOnce();
  });

  it('keeps the song at its starting position while disk preflight is pending', async () => {
    let release: (() => void) | undefined;
    vi.mocked(pythonClient.freeStorageBytes).mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve(1e9);
      }),
    );
    const { result } = await startSession();
    expect(audioClient.play).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe('ready');
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(result.current.state.kind).toBe('playing'));
    expect(recordingCoordinator.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'song' }),
      { sourceSeconds: 0, playbackRate: 1, keyShift: 0 },
    );
    expect(
      vi.mocked(recordingCoordinator.start).mock.invocationCallOrder[0],
    ).toBeLessThan(
      Number(vi.mocked(audioClient.play).mock.invocationCallOrder[0]),
    );
  });

  it('waits for the actual recording target allocation and native Start before Play', async () => {
    const actual = await vi.importActual<
      typeof import('../../services/recordingCoordinator')
    >('../../services/recordingCoordinator');
    let allocate: (() => void) | undefined;
    const pythonRequest = vi.fn(async (request: PythonBridgeRequest) => {
      if (request.path === '/recordings/target')
        await new Promise<void>((resolve) => {
          allocate = resolve;
        });
      return {
        ok: true,
        status: 200,
        body: { recordingId: 'take', filePath: 'D:/take.wav' },
      };
    });
    const audioRequest = vi.fn(
      async ({ command, args }: AudioBridgeRequest) => ({
        status: 0,
        text:
          command === 'GetRecordingState'
            ? args?.details
              ? JSON.stringify({
                  sampleRate: 48000,
                  channels: 2,
                  durationFrames: 0,
                  startSessionFrame: 0,
                  stopSessionFrame: 0,
                  startPlaybackPosition: 0,
                  overrunCount: 0,
                  gapMetadataDropped: 0,
                  staleBlocks: 0,
                  gaps: [],
                })
              : '5'
            : 'Ok',
      }),
    );
    Object.assign(window, { desktop: { pythonRequest, audioRequest } });
    vi.mocked(recordingCoordinator.start).mockImplementationOnce(
      actual.recordingCoordinator.start,
    );
    try {
      const { result } = await startSession();
      await waitFor(() => expect(allocate).toBeDefined());
      expect(audioClient.play).not.toHaveBeenCalled();
      await act(async () => {
        allocate?.();
      });
      await waitFor(() => expect(result.current.state.kind).toBe('playing'));
      expect(
        audioRequest.mock.calls.map(([request]) => request.command),
      ).toEqual(['PrepareRecording', 'StartRecording']);
      expect(audioRequest.mock.invocationCallOrder.at(-1)).toBeLessThan(
        Number(vi.mocked(audioClient.play).mock.invocationCallOrder[0]),
      );
    } finally {
      allocate?.();
      await actual.recordingCoordinator.stop();
      Reflect.deleteProperty(window, 'desktop');
    }
  });

  it.each(['disk', 'prepare'])(
    'does not play after recording %s fails',
    async (stage) => {
      if (stage === 'disk')
        vi.mocked(pythonClient.freeStorageBytes).mockRejectedValueOnce(
          new Error('disk unavailable'),
        );
      else
        vi.mocked(recordingCoordinator.start).mockRejectedValueOnce(
          new Error('native prepare failed'),
        );
      const { result } = await startSession();
      await waitFor(() => expect(result.current.recording).toBe('failed'));
      expect(audioClient.play).not.toHaveBeenCalled();
      expect(result.current.state.kind).toBe('ready');
    },
  );

  it('does not duplicate pending recording preflight after repeated Play clicks', async () => {
    let release: (() => void) | undefined;
    vi.mocked(pythonClient.freeStorageBytes).mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve(1e9);
      }),
    );
    const { result } = await startSession();
    act(() => {
      void result.current.togglePlay();
      void result.current.togglePlay();
    });
    try {
      expect(pythonClient.freeStorageBytes).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        release?.();
      });
    }
  });

  it('finalizes the armed recording if Play fails after recording starts', async () => {
    vi.mocked(audioClient.play).mockRejectedValueOnce(new Error('play failed'));
    const { result } = await startSession();
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));
    expect(recordingCoordinator.start).toHaveBeenCalledOnce();
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(audioClient.stop).toHaveBeenCalledOnce();
  });

  it('keeps a completed Stop after its outstanding Play rejects', async () => {
    let rejectPlay: ((error: Error) => void) | undefined;
    vi.mocked(audioClient.play).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPlay = reject;
      }),
    );
    const { result } = await startSession();
    await waitFor(() => expect(audioClient.play).toHaveBeenCalledOnce());
    await act(async () => {
      await result.current.finishPerformance();
    });
    expect(result.current.state.kind).toBe('finished');

    await act(async () => {
      rejectPlay?.(new Error('cancelled Play reply failed'));
    });

    expect(result.current.state.kind).toBe('finished');
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
  });

  it('applies every displayed mixer value when the native karaoke session becomes ready', async () => {
    let releaseFirst!: () => void;
    vi.mocked(audioClient.setMixer)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(undefined);
          }),
      )
      .mockResolvedValue(undefined);
    renderHook(() => useKaraokeSession('song', 'Normal', true));

    await waitFor(() => expect(audioClient.setMixer).toHaveBeenCalledOnce());
    expect(audioClient.setMixer).toHaveBeenLastCalledWith('music', 0.42);
    await act(async () => {
      releaseFirst();
    });
    await waitFor(() => expect(audioClient.setMixer).toHaveBeenCalledTimes(5));
    expect(vi.mocked(audioClient.setMixer).mock.calls).toEqual([
      ['music', 0.42],
      ['mic', 0.53],
      ['reference', 0.64],
      ['melody', 0.75],
      ['master', 0.86],
    ]);
  });

  it('lets a guest save and leave without asking or permission to stop the room', async () => {
    dialogs.ask.mockResolvedValue('save');
    const { result, rerender } = await startSession();
    await waitFor(() => expect(result.current.recording).toBe('recording'));
    roomState.room = {
      code: 'room',
      hostId: 'host',
      role: 'participant',
      songId: 'song',
      participants: [],
      playbackLocked: false,
      collaborativeControl: false,
    };
    rerender();
    let allowed = false;
    await act(async () => {
      allowed = await result.current.confirmExit();
    });
    expect(allowed).toBe(true);
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(dialogs.ask).not.toHaveBeenCalled();
  });

  it('keeps the route open when saving fails and permits a successful retry', async () => {
    dialogs.ask.mockResolvedValue('save');
    vi.mocked(recordingCoordinator.stop).mockRejectedValueOnce(
      new Error('disk unavailable'),
    );
    const { result } = await startSession();
    await waitFor(() => expect(result.current.recording).toBe('recording'));
    let allowed = true;
    await act(async () => {
      allowed = await result.current.confirmExit();
    });
    expect(allowed).toBe(false);
    expect(result.current.recording).toBe('failed');
    await act(async () => {
      allowed = await result.current.confirmExit();
    });
    expect(allowed).toBe(true);
    expect(recordingCoordinator.stop).toHaveBeenCalledTimes(2);
  });

  it('cannot start recording after Stop overtakes disk preflight', async () => {
    let finishPreflight: (() => void) | undefined;
    vi.mocked(pythonClient.freeStorageBytes).mockReturnValue(
      new Promise((resolve) => {
        finishPreflight = () => resolve(1e9);
      }),
    );
    const { result } = await startSession();
    await act(async () => {
      const finished = result.current.finishPerformance();
      finishPreflight?.();
      await finished;
    });
    expect(recordingCoordinator.start).not.toHaveBeenCalled();
  });

  it('invalidates pending recording preflight when the audio device is lost', async () => {
    let finishPreflight: (() => void) | undefined;
    vi.mocked(pythonClient.freeStorageBytes).mockReturnValue(
      new Promise((resolve) => {
        finishPreflight = () => resolve(1e9);
      }),
    );
    const { result } = await startSession();
    await act(async () => {
      vi.mocked(usePositionPolling).mock.calls.at(-1)?.[0].onLost();
    });
    expect(result.current.state.kind).toBe('recovering');
    await act(async () => {
      vi.mocked(useAudioRecovery).mock.calls.at(-1)?.[0].onRecovered();
      finishPreflight?.();
    });
    expect(recordingCoordinator.start).not.toHaveBeenCalled();
    expect(result.current.recording).toBe('failed');
  });

  it('finalizes a native start that was still pending when Stop arrived', async () => {
    let started: (() => void) | undefined;
    vi.mocked(recordingCoordinator.start).mockReturnValue(
      new Promise((resolve) => {
        started = () => resolve({ recording: true });
      }),
    );
    const { result } = await startSession();
    await waitFor(() =>
      expect(recordingCoordinator.start).toHaveBeenCalledOnce(),
    );
    await act(async () => {
      const finished = result.current.finishPerformance();
      started?.();
      await finished;
    });
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(result.current.recording).toBe('idle');
    expect(result.current.recordingId).toBe('take');
  });

  it('finishes a saved take and exposes its recording id', async () => {
    const { result } = await startSession();
    await waitFor(() => expect(result.current.recording).toBe('recording'));
    const finishing = result.current.finishPerformance();

    await waitFor(() => expect(result.current.state.kind).toBe('finished'), {
      timeout: 500,
    });
    await finishing;
    expect(result.current.recordingId).toBe('take');
    expect(store.cancelPlaylist).toHaveBeenCalledOnce();

    roomState.playbackEnabled = true;
    const selected: RoomStateDto = {
      code: 'room',
      hostId: 'host',
      role: 'host',
      participants: [],
      playbackLocked: false,
      songId: 'song',
      performanceId: 1,
      playbackState: 'stopped',
    };
    const song: SongDto = {
      id: 'song',
      title: 'Song',
      artist: 'Singer',
      language: 'Auto',
      status: 'ready',
      durationSeconds: 60,
      createdAt: '',
      coverState: 'Fallback',
      activeRevision: 1,
      projectFormatVersion: 1,
    };
    const roomTake = renderHook(
      ({ room }) =>
        useKaraokeRecording({
          room,
          roomPlayback: useRoomPlayback(),
          dispatch: vi.fn(),
          playbackGeneration: { current: 0 },
          songRef: { current: song },
          positionRef: { current: 0 },
          speedRef: { current: 1 },
          keyRef: { current: 0 },
        }),
      { initialProps: { room: selected } },
    );
    roomTake.rerender({
      room: { ...selected, performanceId: 2, playbackState: 'playing' },
    });
    await act(async () => {
      await roomTake.result.current.startRecording();
    });
    roomTake.rerender({
      room: { ...selected, songId: undefined, performanceId: 3 },
    });
    await act(async () => {
      await roomTake.result.current.finishLocalPerformance();
    });
    expect(roomState.playback.finalPerformance).toHaveBeenCalledWith(2);
  });

  it('saves at natural EOF without cancelling the remaining playlist', async () => {
    const { result } = await startSession();
    await waitFor(() => expect(result.current.recording).toBe('recording'));
    act(() => {
      vi.mocked(usePositionPolling).mock.calls.at(-1)?.[0].onFinished();
    });
    await waitFor(() => expect(result.current.state.kind).toBe('finished'));
    expect(recordingCoordinator.stop).toHaveBeenCalledOnce();
    expect(result.current.recordingId).toBe('take');
    expect(store.cancelPlaylist).not.toHaveBeenCalled();
  });

  it('does not record after its route unmounts while disk preflight is pending', async () => {
    let finishPreflight: (() => void) | undefined;
    vi.mocked(pythonClient.freeStorageBytes).mockReturnValue(
      new Promise((resolve) => {
        finishPreflight = () => resolve(1e9);
      }),
    );
    const { unmount } = await startSession();
    unmount();
    await act(async () => {
      finishPreflight?.();
    });
    expect(recordingCoordinator.start).not.toHaveBeenCalled();
  });
});
