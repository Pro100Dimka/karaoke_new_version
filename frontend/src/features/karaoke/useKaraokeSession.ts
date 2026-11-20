import {
  useKaraokeRecording,
  useKaraokeRecordingPlayback,
} from './useKaraokeRecording';
import { usePreparedRoomAudio } from './usePreparedRoomAudio';
import { observable, runInAction } from 'mobx';
import { tr, useLocale } from '@neo-ui-kit/react';
import { store } from '../../providers/store';
import { audioClient } from '../../services/audioClient';
import { recordingCoordinator } from '../../services/recordingCoordinator';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useRoomPlayback } from '../../providers/application';
import { useCloseGuard } from '../../providers/close-guards';
import { useNotify } from '../../providers/notifications';
import type {
  MixerChannelGains,
  PlaybackSnapshot,
  SongDto,
} from '../../contracts/models';
import type { KaraokeNoteScore } from '../../contracts/models';
import { toAppError } from '../../shared/errors';
import { reduceKaraoke } from '../../application/karaoke/karaokeMachine';
import { useAudioRecovery } from './useAudioRecovery';
import { useKaraokeControls } from './useKaraokeControls';
import { releaseKaraokeAudio } from './karaokeAudioLifecycle';
import { usePositionPolling } from './usePositionPolling';
import {
  roomSelectionEnded,
  roomToggleCommand,
} from '../../application/room/roomPlayback';
import { useKeyboardLighting } from './useKeyboardLighting';
import { useKaraokeLoadSession } from './useKaraokeLoadSession';
import { useSynchronizedRoomPlayback } from './useSynchronizedRoomPlayback';
import {
  allConnectedReady,
  canControlRoom,
} from '../../application/room/roomModel';

export type { KaraokeOpenMode } from '../../application/karaoke/karaokeMachine';
import type { KaraokeOpenMode } from '../../application/karaoke/karaokeMachine';

export const useKaraokeSession = (
  songId: string,
  mode: KaraokeOpenMode,
  startReleased: boolean,
) => {
  const { preferences } = store;
  const { room } = store.online;
  const roomPlayback = useRoomPlayback();
  const notify = useNotify();
  const locale = useLocale();

  const [state, dispatch] = useReducer(reduceKaraoke, {
    kind: 'preparing',
  });
  // Display consumers subscribe locally; audio lifecycle stays with this session.
  const [playback] = useState(() =>
    observable.object<
      Pick<PlaybackSnapshot, 'pitchHz' | 'pitchFrames'> & { position: number }
    >(
      { position: 0, pitchHz: undefined, pitchFrames: undefined },
      {},
      { deep: false },
    ),
  );
  const setPosition = useCallback(
    (value: number | ((previous: number) => number)) =>
      runInAction(() => {
        playback.position =
          typeof value === 'function' ? value(playback.position) : value;
      }),
    [playback],
  );
  const readPosition = useCallback(() => playback.position, [playback]);
  const [speed, setSpeed] = useState(1);
  const [keyShift, setKeyShift] = useState(0);
  const [monitoring, setMonitoring] = useState(false);

  const [recoveredNotice, setRecoveredNotice] = useState(false);
  const initialGains = useRef<MixerChannelGains>({
    music: preferences.musicGain,
    mic: preferences.voiceGain,
    reference: preferences.referenceGain,
    melody: preferences.melodyGain,
    master: preferences.masterGain,
  });
  const [channelGains, setGains] = useState<MixerChannelGains>(
    initialGains.current,
  );
  // The microphone knob shows the singer's stored volume, whichever screen last changed it.
  const gains = useMemo(
    () => ({ ...channelGains, mic: preferences.voiceGain }),
    [channelGains, preferences.voiceGain],
  );
  const gainsRef = useRef(gains);
  gainsRef.current = gains;

  const stateRef = useRef(state);
  stateRef.current = state;
  const playbackGeneration = useRef(0);
  const recoveryIntent = useRef({ playing: false, recording: false });
  const positionRef = useRef(0);

  const speedRef = useRef(speed);
  speedRef.current = speed;
  const keyRef = useRef(keyShift);
  keyRef.current = keyShift;
  const songRef = useRef<SongDto | null>(null);
  const {
    recordingWork,
    recording,
    setRecording,
    recordingRef,
    recordingId,
    finishLocalPerformance,
    startRecording,
  } = useKaraokeRecording({
    room,
    roomPlayback,
    dispatch,
    playbackGeneration,
    songRef,
    positionRef,
    speedRef,
    keyRef,
  });

  const fail = useCallback(
    (error: unknown) => dispatch({ type: 'FAIL', error: toAppError(error) }),
    [],
  );
  const { load, document, songPrefs, capabilities, refreshCapabilities } =
    useKaraokeLoadSession(
      songId,
      mode,
      initialGains.current,
      () => dispatch({ type: 'PREPARED' }),
      fail,
      () => {
        dispatch({ type: 'RESTART' });
        setSpeed(1);
        setKeyShift(0);
      },
    );
  // Commit this participant's latest personal mixer values once the native session is ready.
  const mixerSessionReady =
    load.kind === 'ready' &&
    ['ready', 'playing', 'paused'].includes(state.kind);
  useEffect(() => {
    if (!mixerSessionReady) return;
    let active = true;
    void (async () => {
      for (const [channel, value] of Object.entries(gainsRef.current)) {
        if (!active) return;
        await audioClient.setMixer(channel as keyof MixerChannelGains, value);
      }
    })().catch((error) => {
      if (active) fail(error);
    });
    return () => {
      active = false;
    };
  }, [mixerSessionReady, fail]);

  const song = load.kind === 'ready' ? load.song : null;
  const roomReady = !room || allConnectedReady(room);

  songRef.current = song;
  // Song availability and player readiness are different states. Report Ready only after this
  // instance has loaded the exact project and prepared AudioService; the server then schedules one
  // future start for the whole room instead of letting early clients play while others still load.
  usePreparedRoomAudio(room, mode, load.kind, state.kind, roomPlayback, fail);

  // ---- finishing a performance: EOF and Stop share one path so recording is always finalized ----

  const finishPerformance = useCallback(
    async (naturalEnd = false) => {
      if (room) {
        if (naturalEnd && room.role !== 'host') return finishLocalPerformance();
        if (!canControlRoom(room)) return false;
        try {
          await roomPlayback?.control('Stop', undefined, naturalEnd);
        } catch (error) {
          fail(error);
          return false;
        }
        if (!(await finishLocalPerformance())) return false;
        try {
          if (!naturalEnd || !room.playlist) await roomPlayback?.clearSong();
        } catch (error) {
          fail(error);
          return false;
        }
        return true;
      }
      if (!naturalEnd) store.cancelPlaylist();
      return finishLocalPerformance();
    },
    [room, roomPlayback, fail, finishLocalPerformance],
  );

  // A synchronized Back/Stop must finalize the local take before this route disappears. RoomSync
  // deliberately leaves navigation to this shared solo lifecycle so analysis and exit animation run.
  useEffect(() => {
    if (roomSelectionEnded(mode, room?.songId, state.kind))
      void finishLocalPerformance();
  }, [mode, room?.songId, state.kind, finishLocalPerformance]);

  const isPollable = useCallback(
    () => ['playing', 'paused', 'ready'].includes(stateRef.current.kind),
    [],
  );
  const isPlaying = useCallback(() => stateRef.current.kind === 'playing', []);
  const onPosition = useCallback(
    (seconds: number) => {
      positionRef.current = seconds;
      setPosition(seconds);
      if (stateRef.current.kind === 'playing')
        recordingCoordinator.observePosition(seconds);
    },
    [recordingCoordinator, setPosition],
  );
  const monitoringWarningShown = useRef(false);
  const onAudioSnapshot = useCallback(
    (snapshot: PlaybackSnapshot) => {
      if (stateRef.current.kind === 'playing') {
        if (!room)
          recordingCoordinator.observeMicrophoneActivity(snapshot.pitchFrames);
        runInAction(() => {
          playback.pitchHz = snapshot.pitchHz;
          playback.pitchFrames = snapshot.pitchFrames;
        });
      }
      setMonitoring(snapshot.monitoring);
      if (snapshot.monitoringSafetyTripped && !monitoringWarningShown.current) {
        notify(tr('monitoringSafetyStopped'), 'error');
      }
      monitoringWarningShown.current = Boolean(
        snapshot.monitoringSafetyTripped,
      );
    },
    [notify, locale, playback, room],
  );
  const onLost = useCallback(() => {
    if (['playing', 'paused'].includes(stateRef.current.kind)) {
      recoveryIntent.current.playing ||=
        !room && mode !== 'RoomPrepared' && stateRef.current.kind === 'playing';
      recoveryIntent.current.recording ||= ['starting', 'recording'].includes(
        recordingRef.current,
      );
    }
    playbackGeneration.current++;
    recordingWork.invalidate();
    recordingCoordinator.interrupt();
    setRecording((current) =>
      ['starting', 'recording'].includes(current) ? 'failed' : current,
    );
    dispatch({ type: 'AUDIO_LOST' });
  }, [recordingWork, recordingCoordinator, room, mode]);
  const onFinished = useCallback(
    () => void finishPerformance(true),
    [finishPerformance],
  );
  const positionPolling = usePositionPolling({
    enabled: load.kind === 'ready',
    isPollable,
    isPlaying,
    onPosition,
    onSnapshot: onAudioSnapshot,
    onFinished,
    onLost,
  });

  const onRecovered = useCallback(() => {
    setRecoveredNotice(true);
    setMonitoring(false);
    if (recoveryIntent.current.recording) setRecording('idle');
    dispatch({ type: 'AUDIO_RECOVERED' });
  }, []);
  useAudioRecovery({
    recovering: state.kind === 'recovering',
    song: songRef,
    position: positionRef,
    speed: speedRef,
    key: keyRef,
    onRecovered,
  });
  useKeyboardLighting(
    preferences.keyboardLighting,
    preferences.theme,
    readPosition,
    state.kind === 'playing',
  );

  // Tempo and key are authoritative room parameters. Every participant applies the same snapshot locally.
  useEffect(() => {
    if (!room || load.kind !== 'ready') return;
    const nextSpeed = room.playbackRate ?? 1;
    const nextKey = room.keyShift ?? 0;
    const speedChanged = speedRef.current !== nextSpeed;
    const keyChanged = keyRef.current !== nextKey;
    if (!speedChanged && !keyChanged) return;
    speedRef.current = nextSpeed;
    keyRef.current = nextKey;
    setSpeed(nextSpeed);
    setKeyShift(nextKey);
    void Promise.all([
      audioClient.setPlaybackRate(nextSpeed),
      audioClient.setPitchShift(nextKey),
    ]).catch(fail);
  }, [room?.code, room?.playbackRate, room?.keyShift, load.kind, fail]);

  // ---- leaving: nothing may keep playing or recording after the route closes ----
  useEffect(
    () => () => {
      playbackGeneration.current++;
      recordingWork.invalidate();
      void releaseKaraokeAudio(audioClient, recordingCoordinator);
    },
    [],
  );

  const confirmExit = useCallback(async (): Promise<boolean> => {
    if (
      recordingRef.current !== 'starting' &&
      !recordingCoordinator.hasPendingTake()
    )
      return true;
    return room && !canControlRoom(room)
      ? finishLocalPerformance()
      : finishPerformance();
  }, [finishLocalPerformance, finishPerformance, room, recordingCoordinator]);

  useCloseGuard(confirmExit);

  const interactive =
    roomReady && ['ready', 'playing', 'paused'].includes(state.kind);

  // Solo playback waits for recording preflight; room playback remains governed by the server.

  const playPending = useRef(false);
  const togglePlay = useCallback(async () => {
    if (!room && playPending.current) return;
    const generation = playbackGeneration.current;
    setRecoveredNotice(false);
    try {
      if (room) {
        const command = roomToggleCommand(room);
        if (command === 'Start') await roomPlayback?.start();
        else if (command) await roomPlayback?.control(command);
        return;
      }
      playPending.current = true;
      if (stateRef.current.kind === 'playing') {
        await audioClient.pause();
        if (generation !== playbackGeneration.current) return;
        dispatch({ type: 'PAUSE' });
      } else if (['ready', 'paused'].includes(stateRef.current.kind)) {
        if (mode !== 'Rehearsal' && recordingRef.current !== 'recording') {
          const current = await refreshCapabilities();
          if (generation !== playbackGeneration.current) return;
          if (current.microphone === 'ready' && !(await startRecording()))
            return;
        }
        if (generation !== playbackGeneration.current) return;
        await audioClient.play();
        if (generation !== playbackGeneration.current) return;
        dispatch({ type: 'PLAY' });
      }
    } catch (error) {
      if (!room && generation !== playbackGeneration.current) return;
      if (!room && recordingRef.current === 'recording')
        await finishLocalPerformance();
      fail(error);
    } finally {
      playPending.current = false;
    }
  }, [
    room,
    roomPlayback,
    mode,
    fail,
    refreshCapabilities,
    startRecording,
    finishLocalPerformance,
  ]);

  useEffect(() => {
    if (room || state.kind !== 'paused' || !recoveryIntent.current.playing)
      return;
    const generation = playbackGeneration.current;
    void togglePlay().then(() => {
      if (generation === playbackGeneration.current)
        recoveryIntent.current = { playing: false, recording: false };
    });
  }, [room, state.kind, togglePlay]);

  const onRoomPlaybackEvent = useCallback(
    (event: 'PLAY' | 'PAUSE') => dispatch({ type: event }),
    [],
  );
  useSynchronizedRoomPlayback({
    room,
    ready: load.kind === 'ready' && roomReady,
    stateKind: state.kind,
    onEvent: onRoomPlaybackEvent,
    onFinished: finishLocalPerformance,
    onFailure: fail,
  });

  // Opened from the library, the performance starts on its own once the opening scene releases it.
  useEffect(() => {
    if (
      ['AutoStart', 'Rehearsal'].includes(mode) &&
      startReleased &&
      state.kind === 'ready' &&
      recording === 'idle'
    )
      void togglePlay();
  }, [mode, startReleased, state.kind, recording, togglePlay]);

  const controls = useKaraokeControls({
    position: positionRef,
    speed: speedRef,
    key: keyRef,
    monitoring,
    ready: mixerSessionReady,
    microphoneReady: capabilities.microphone === 'ready',
    setPosition,
    setSpeed,
    setKeyShift,
    setGains,
    setMonitoring,
  });
  const updateKaraokeNoteScore = useCallback(
    (score: KaraokeNoteScore) => {
      recordingCoordinator.updateKaraokeNoteScore(score);
      if (room?.performanceId !== undefined)
        void roomPlayback
          ?.publishPerformance(room.performanceId, score)
          .catch(() => undefined);
    },
    [recordingCoordinator, roomPlayback, room?.performanceId],
  );
  // A poll started just before a seek can still resolve just after it, carrying the pre-seek position;
  // applying that would flash the highlight, piano roll and scene video (all driven by this same position)
  // back a moment. Invalidating around the seek drops that reply, whether it was already in flight or
  // issued by a poll tick that lands while the seek itself is still in the air.
  const seek = useCallback(
    async (seconds: number) => {
      positionPolling.invalidate();
      try {
        await controls.seek(seconds);
      } finally {
        positionPolling.invalidate();
      }
    },
    [controls.seek, positionPolling.invalidate],
  );

  useKaraokeRecordingPlayback({
    room,
    mode,
    stateKind: state.kind,
    recording,
    microphone: capabilities.microphone,
    startRecording,
    positionRef,
    speedRef,
    keyRef,
  });

  return {
    load,
    state,
    get position() {
      return playback.position;
    },
    get pitchHz() {
      return playback.pitchHz;
    },
    get pitchFrames() {
      return playback.pitchFrames;
    },
    document,
    songPrefs,
    capabilities,
    speed,
    keyShift,
    monitoring,
    recording,
    recordingId,
    recoveredNotice,
    gains,
    interactive,
    practiceLocked: Boolean(
      room && (!canControlRoom(room) || room.playbackLocked),
    ),

    togglePlay,
    ...controls,
    seek,
    finishPerformance,
    confirmExit,
    updateKaraokeNoteScore,
  };
};
