import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";
import { recordingCoordinator } from "../../services/recordingCoordinator";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useApp, useRoomPlayback } from "../../app/AppContext";
import { useAsk } from "../../app/DialogProvider";
import { useCloseGuard } from "../../app/CloseGuards";
import { useNotify } from "../../app/NotificationsProvider";
import type {
  AppError,
  MixerChannelGains,
  PlaybackSnapshot,
  SongDto,
} from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { KaraokeRecordingCoordinator } from "../../application/karaoke/KaraokeRecordingCoordinator";
import type { KaraokeNoteScore } from "../../contracts/models";
import { toAppError } from "../../shared/errors";
import {
  reduceKaraoke,
  type KaraokeState,
} from "../../application/karaoke/karaokeMachine";
import { askInsufficientDisk } from "./askInsufficientDisk";
import { useAudioRecovery } from "./useAudioRecovery";
import { useKaraokeControls } from "./useKaraokeControls";
import { releaseKaraokeAudio } from "./karaokeAudioLifecycle";
import { usePositionPolling } from "./usePositionPolling";
import {
  roomSelectionEnded,
  roomToggleCommand,
} from "../../application/room/roomPlayback";
import { useKeyboardLighting } from "./useKeyboardLighting";
import { useKaraokeLoadSession } from "./useKaraokeLoadSession";
import { useSynchronizedRoomPlayback } from "./useSynchronizedRoomPlayback";
import { createSingleFlight } from "./performanceFinish";
import {
  allConnectedReady,
  canControlRoom,
} from "../../application/room/roomModel";

export type { KaraokeOpenMode } from "../../application/karaoke/karaokeMachine";
import type { KaraokeOpenMode } from "../../application/karaoke/karaokeMachine";

type RecordingUiState =
  "idle" | "starting" | "recording" | "stopping" | "failed";

export const useKaraokeSession = (
  songId: string,
  mode: KaraokeOpenMode,
  startReleased: boolean,
) => {
  const recordingWorkRef = useRef<KaraokeRecordingCoordinator>(null);
  recordingWorkRef.current ??= new KaraokeRecordingCoordinator(
    pythonClient,
    recordingCoordinator,
    audioClient,
  );
  const recordingWork = recordingWorkRef.current;
  const { preferences, updatePreferences, openSettings, room } = useApp();
  const roomPlayback = useRoomPlayback();
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();

  const [state, dispatch] = useReducer(reduceKaraoke, {
    kind: "preparing",
  } as KaraokeState);
  const [position, setPosition] = useState(0);
  const [pitchHz, setPitchHz] = useState<number | undefined>();
  const [pitchFrames, setPitchFrames] =
    useState<PlaybackSnapshot["pitchFrames"]>();
  const [speed, setSpeed] = useState(1);
  const [keyShift, setKeyShift] = useState(0);
  const [monitoring, setMonitoring] = useState(false);
  const [recording, setRecording] = useState<RecordingUiState>("idle");
  const [recordingId, setRecordingId] = useState<string | undefined>();
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
  const positionRef = useRef(0);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const keyRef = useRef(keyShift);
  keyRef.current = keyShift;

  const fail = useCallback(
    (error: unknown) =>
      dispatch({ type: "FAIL", error: toAppError(error) satisfies AppError }),
    [],
  );
  const { load, document, songPrefs, capabilities } = useKaraokeLoadSession(
    songId,
    mode,
    initialGains.current,
    () => dispatch({ type: "PREPARED" }),
    fail,
    () => {
      dispatch({ type: "RESTART" });
      setSpeed(1);
      setKeyShift(0);
    },
  );
  // Commit this participant's latest personal mixer values once the native session is ready.
  const mixerSessionReady =
    load.kind === "ready" &&
    ["ready", "playing", "paused"].includes(state.kind);
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

  const song = load.kind === "ready" ? load.song : null;
  const roomReady = !room || allConnectedReady(room);
  const songRef = useRef<SongDto | null>(null);
  songRef.current = song;
  // Song availability and player readiness are different states. Report Ready only after this
  // instance has loaded the exact project and prepared AudioService; the server then schedules one
  // future start for the whole room instead of letting early clients play while others still load.
  useEffect(() => {
    if (
      !room ||
      mode !== "RoomPrepared" ||
      load.kind !== "ready" ||
      state.kind !== "ready" ||
      !roomPlayback ||
      !room.songId ||
      room.revision === undefined
    )
      return;
    void roomPlayback.reportReady(room.songId, room.revision).catch(fail);
  }, [
    room?.code,
    room?.songId,
    room?.revision,
    mode,
    load.kind,
    state.kind,
    roomPlayback,
    fail,
  ]);

  // ---- finishing a performance: EOF and Stop share one path so recording is always finalized ----
  const finishLocalWork = useCallback(async () => {
    playbackGeneration.current++;
    dispatch({ type: "STOPPING" });
    setRecording("stopping");
    const result = await recordingWork.finish();
    if (result.recordingId) {
      setRecordingId(result.recordingId);
      notify(t("recordingSaved"), "success");
    }
    if (!result.saved) {
      setRecording("failed");
      notify(t("recordingFailed"), "error");
    }
    setRecording((current) => (current === "failed" ? current : "idle"));
    dispatch({ type: "FINISH" });
    return result.saved;
  }, [notify, t, recordingWork]);
  const finishLocalWorkRef = useRef(finishLocalWork);
  finishLocalWorkRef.current = finishLocalWork;
  const finishLocalPerformanceRef = useRef<() => Promise<boolean>>(undefined);
  finishLocalPerformanceRef.current ??= createSingleFlight(() =>
    finishLocalWorkRef.current(),
  );
  const finishLocalPerformance = finishLocalPerformanceRef.current;

  const finishPerformance = useCallback(async () => {
    if (room) {
      if (!canControlRoom(room)) return false;
      try {
        await roomPlayback?.control("Stop");
      } catch (error) {
        fail(error);
        return false;
      }
      if (!(await finishLocalPerformance())) return false;
      try {
        await roomPlayback?.clearSong();
      } catch (error) {
        fail(error);
        return false;
      }
      return true;
    }
    return finishLocalPerformance();
  }, [room, roomPlayback, fail, finishLocalPerformance]);

  // A synchronized Back/Stop must finalize the local take before this route disappears. RoomSync
  // deliberately leaves navigation to this shared solo lifecycle so analysis and exit animation run.
  useEffect(() => {
    if (roomSelectionEnded(mode, room?.songId, state.kind))
      void finishLocalPerformance();
  }, [mode, room?.songId, state.kind, finishLocalPerformance]);

  const isPollable = useCallback(
    () => ["playing", "paused", "ready"].includes(stateRef.current.kind),
    [],
  );
  const isPlaying = useCallback(() => stateRef.current.kind === "playing", []);
  const onPosition = useCallback(
    (seconds: number) => {
      positionRef.current = seconds;
      setPosition(seconds);
      if (stateRef.current.kind === "playing")
        recordingCoordinator.observePosition(seconds);
    },
    [recordingCoordinator],
  );
  const monitoringWarningShown = useRef(false);
  const onAudioSnapshot = useCallback(
    (snapshot: PlaybackSnapshot) => {
      if (stateRef.current.kind === "playing") {
        setPitchHz(snapshot.pitchHz);
        setPitchFrames(snapshot.pitchFrames);
      }
      setMonitoring(snapshot.monitoring);
      if (snapshot.monitoringSafetyTripped && !monitoringWarningShown.current) {
        monitoringWarningShown.current = true;
        notify(t("monitoringSafetyStopped"), "error");
      } else if (!snapshot.monitoringSafetyTripped) {
        monitoringWarningShown.current = false;
      }
    },
    [notify, t],
  );
  const onLost = useCallback(() => {
    playbackGeneration.current++;
    recordingWork.invalidate();
    recordingCoordinator.interrupt();
    setRecording((current) =>
      ["starting", "recording"].includes(current) ? "failed" : current,
    );
    dispatch({ type: "AUDIO_LOST" });
  }, [recordingWork, recordingCoordinator]);
  const onFinished = useCallback(
    () => void finishPerformance(),
    [finishPerformance],
  );
  const positionPolling = usePositionPolling({
    enabled: load.kind === "ready",
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
    setRecording((current) => (current === "recording" ? "failed" : current));
    dispatch({ type: "AUDIO_RECOVERED" });
  }, []);
  useAudioRecovery({
    recovering: state.kind === "recovering",
    song: songRef,
    position: positionRef,
    speed: speedRef,
    key: keyRef,
    onRecovered,
  });
  useKeyboardLighting(
    preferences.keyboardLighting,
    preferences.theme,
    position,
    state.kind === "playing",
  );

  // Tempo and key are authoritative room parameters. Every participant applies the same snapshot locally.
  useEffect(() => {
    if (!room || load.kind !== "ready") return;
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
      recordingRef.current !== "starting" &&
      !recordingCoordinator.hasPendingTake()
    )
      return true;
    return room && !canControlRoom(room)
      ? finishLocalPerformance()
      : finishPerformance();
  }, [finishLocalPerformance, finishPerformance, room, recordingCoordinator]);

  useCloseGuard(confirmExit);

  const interactive =
    roomReady &&
    (state.kind === "ready" ||
      state.kind === "playing" ||
      state.kind === "paused");

  // Solo playback waits for recording preflight; room playback remains governed by the server.
  const startRecording = useCallback(async () => {
    const target = songRef.current;
    if (!target) return false;
    recordingRef.current = "starting";
    setRecording("starting");
    const result = await recordingWork.start(target, {
      sourceSeconds: positionRef.current,
      playbackRate: speedRef.current,
      keyShift: keyRef.current,
    });
    if (result.kind === "cancelled") return false;
    recordingRef.current = result.kind === "started" ? "recording" : "failed";
    if (result.kind === "insufficientDisk") {
      setRecording("failed");
      const choice = await askInsufficientDisk(ask, t, result.free);
      if (recordingWork.isCurrent(result.generation) && choice === "storage")
        openSettings("advanced");
      return false;
    }
    if (result.kind === "started") setRecording("recording");
    else {
      setRecording("failed");
      notify(t("recordingFailed"), "error");
    }
    return result.kind === "started";
  }, [ask, notify, openSettings, t, recordingWork]);

  const playPending = useRef(false);
  const togglePlay = useCallback(async () => {
    if (!room && playPending.current) return;
    const generation = playbackGeneration.current;
    setRecoveredNotice(false);
    try {
      if (room) {
        const command = roomToggleCommand(room);
        if (command === "Start") await roomPlayback?.start();
        else if (command) await roomPlayback?.control(command);
        return;
      }
      playPending.current = true;
      if (stateRef.current.kind === "playing") {
        await audioClient.pause();
        if (generation !== playbackGeneration.current) return;
        dispatch({ type: "PAUSE" });
      } else if (
        stateRef.current.kind === "ready" ||
        stateRef.current.kind === "paused"
      ) {
        if (
          mode !== "Rehearsal" &&
          capabilities.microphone === "ready" &&
          recordingRef.current !== "recording" &&
          !(await startRecording())
        )
          return;
        if (generation !== playbackGeneration.current) return;
        await audioClient.play();
        if (generation !== playbackGeneration.current) return;
        dispatch({ type: "PLAY" });
      }
    } catch (error) {
      if (!room && generation !== playbackGeneration.current) return;
      if (!room && recordingRef.current === "recording")
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
    capabilities.microphone,
    startRecording,
    finishLocalPerformance,
  ]);

  const onRoomPlaybackEvent = useCallback(
    (event: "PLAY" | "PAUSE") => dispatch({ type: event }),
    [],
  );
  useSynchronizedRoomPlayback({
    room,
    ready: load.kind === "ready" && roomReady,
    stateKind: state.kind,
    onEvent: onRoomPlaybackEvent,
    onFinished: finishLocalPerformance,
    onFailure: fail,
  });

  // Opened from the library, the performance starts on its own once the opening scene releases it.
  useEffect(() => {
    if (
      (mode === "AutoStart" || mode === "Rehearsal") &&
      startReleased &&
      state.kind === "ready" &&
      recording === "idle"
    )
      void togglePlay();
  }, [mode, startReleased, state.kind, recording, togglePlay]);

  const controls = useKaraokeControls({
    position: positionRef,
    speed: speedRef,
    key: keyRef,
    monitoring,
    ready: mixerSessionReady,
    microphoneReady: capabilities.microphone === "ready",
    setPosition,
    setSpeed,
    setKeyShift,
    setGains,
    setMonitoring,
  });
  const updateKaraokeNoteScore = useCallback(
    (score: KaraokeNoteScore) =>
      recordingCoordinator.updateKaraokeNoteScore(score),
    [recordingCoordinator],
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

  useEffect(() => {
    if (
      room &&
      state.kind === "playing" &&
      recording === "idle" &&
      capabilities.microphone === "ready"
    )
      void startRecording();
  }, [room, state.kind, recording, capabilities.microphone, startRecording]);

  // Solo and room pauses both land here: the take pauses with the song and resumes where the song resumes.
  useEffect(() => {
    if (state.kind === "paused")
      void recordingCoordinator.pause().catch(() => undefined);
    if (state.kind === "playing") {
      void recordingCoordinator
        .resume({
          sourceSeconds: positionRef.current,
          playbackRate: speedRef.current,
          keyShift: keyRef.current,
        })
        .catch(() => undefined);
    }
  }, [state.kind]);

  const setShowNotes = useCallback((value: boolean) =>
    updatePreferences({ karaokeShowNotes: value }), [updatePreferences]);
  const setShowLyrics = useCallback((value: boolean) =>
    updatePreferences({ karaokeShowLyrics: value }), [updatePreferences]);
  const setAutoHideConsole = useCallback((value: boolean) =>
    updatePreferences({ karaokeAutoHideConsole: value }), [updatePreferences]);
  const setEffectValues = useCallback((value: typeof preferences.karaokeEffects) =>
    updatePreferences({ karaokeEffects: value }), [updatePreferences]);

  return {
    load,
    state,
    position,
    pitchHz,
    pitchFrames,
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
    showNotes: preferences.karaokeShowNotes,
    showLyrics: preferences.karaokeShowLyrics,
    autoHideConsole: preferences.karaokeAutoHideConsole,
    noiseSuppression: preferences.noiseSuppression,
    effectValues: preferences.karaokeEffects,
    setShowNotes,
    setShowLyrics,
    setAutoHideConsole,
    setEffectValues,
    togglePlay,
    ...controls,
    seek,
    finishPerformance,
    confirmExit,
    updateKaraokeNoteScore,
  };
};
