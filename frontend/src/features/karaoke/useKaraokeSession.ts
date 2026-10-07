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
  SongDto,
} from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { useKaraokeAudio, useKaraokeBackend, useKaraokeRecording } from "../../app/KaraokeProvider";
import type { KaraokeNoteScore } from "../../contracts/models";
import { toAppError } from "../../shared/errors";
import { reduceKaraoke, type KaraokeState } from "../../application/karaoke/karaokeMachine";
import {
  askInsufficientDisk,
  minimumRecordingBytes,
} from "./askInsufficientDisk";
import { useAudioRecovery } from "./useAudioRecovery";
import { useKaraokeControls } from "./useKaraokeControls";
import { releaseKaraokeAudio } from "./karaokeAudioLifecycle";
import { usePositionPolling } from "./usePositionPolling";
import { roomSelectionEnded, roomToggleCommand } from "../../application/room/roomPlayback";
import { useKeyboardLighting } from "./useKeyboardLighting";
import { useKaraokeLoadSession } from "./useKaraokeLoadSession";
import { useSynchronizedRoomPlayback } from "./useSynchronizedRoomPlayback";
import { createSingleFlight } from "./performanceFinish";
import { allConnectedReady, canControlRoom } from "../../application/room/roomModel";

export type { KaraokeOpenMode } from "../../application/karaoke/karaokeMachine";
import type { KaraokeOpenMode } from "../../application/karaoke/karaokeMachine";

type RecordingUiState =
  "idle" | "starting" | "recording" | "stopping" | "failed";

export const useKaraokeSession = (
  songId: string,
  mode: KaraokeOpenMode,
  startReleased: boolean,
) => {
  const audioClient = useKaraokeAudio();
  const pythonClient = useKaraokeBackend();
  const recordingCoordinator = useKaraokeRecording();
  const { preferences, updatePreferences, openSettings, room } =
    useApp();
  const roomPlayback = useRoomPlayback();
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();

  const [state, dispatch] = useReducer(reduceKaraoke, {
    kind: "preparing",
  } as KaraokeState);
  const [position, setPosition] = useState(0);
  const [pitchHz, setPitchHz] = useState<number | undefined>();
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
  const positionRef = useRef(0);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const recordingEpoch = useRef(0);
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
  const restoreLocalMonitoring =
    !room && preferences.karaokeMonitoring && capabilities.microphone === "ready";
  useEffect(() => {
    if (!restoreLocalMonitoring || load.kind !== "ready" || state.kind !== "ready")
      return;
    let active = true;
    void audioClient
      .setMonitoring(true)
      .then((snapshot) => {
        if (active) setMonitoring(snapshot.monitoring);
      })
      .catch((error) => {
        if (active) fail(error);
      });
    return () => {
      active = false;
    };
  }, [restoreLocalMonitoring, load.kind, state.kind, fail]);

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
      !roomPlayback || !room.songId || room.revision === undefined
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
    recordingEpoch.current++;
    dispatch({ type: "STOPPING" });
    let takeId: string | undefined;
    let saved = true;
    setRecording("stopping");
    try {
      takeId = (await recordingCoordinator.stop()).recordingId;
      if (takeId) {
        setRecordingId(takeId);
        notify(t("recordingSaved"), "success");
      }
    } catch {
      saved = false;
      setRecording("failed");
      notify(t("recordingFailed"), "error");
    }
    await audioClient.stop().catch(() => undefined);
    setRecording((current) => (current === "failed" ? current : "idle"));
    dispatch({ type: "FINISH" });
    return saved;
  }, [notify, t]);
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
  const onPosition = useCallback((seconds: number) => {
    positionRef.current = seconds;
    setPosition(seconds);
    if (stateRef.current.kind === "playing")
      recordingCoordinator.observePosition(seconds);
  }, []);
  const onAudioSnapshot = useCallback(
    (snapshot: { pitchHz?: number }) => setPitchHz(snapshot.pitchHz),
    [],
  );
  const onLost = useCallback(() => {
    recordingEpoch.current++;
    setRecording((current) =>
      ["starting", "recording"].includes(current) ? "failed" : current,
    );
    dispatch({ type: "AUDIO_LOST" });
  }, []);
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
      recordingEpoch.current++;
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
    const choice = await ask({
      title: t("leaveWhileRecordingTitle"),
      body: t("leaveWhileRecordingBody"),
      actions: [
        { id: "cancel", label: t("cancel") },
        { id: "save", label: t("stopAndSave"), appearance: "primary" },
      ],
    });
    if (choice !== "save") return false;
    return room && !canControlRoom(room)
      ? finishLocalPerformance()
      : finishPerformance();
  }, [ask, finishLocalPerformance, finishPerformance, room, t]);

  useCloseGuard(confirmExit);

  const interactive =
    roomReady &&
    (state.kind === "ready" ||
      state.kind === "playing" ||
      state.kind === "paused");

  const togglePlay = useCallback(async () => {
    setRecoveredNotice(false);
    try {
      if (room) {
        const command = roomToggleCommand(room);
        if (command === "Start") await roomPlayback?.start();
        else if (command) await roomPlayback?.control(command);
        return;
      }
      if (stateRef.current.kind === "playing") {
        await audioClient.pause();
        dispatch({ type: "PAUSE" });
      } else if (
        stateRef.current.kind === "ready" ||
        stateRef.current.kind === "paused"
      ) {
        await audioClient.play();
        dispatch({ type: "PLAY" });
      }
    } catch (error) {
      fail(error);
    }
  }, [room, roomPlayback, fail]);

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
      mode === "AutoStart" &&
      startReleased &&
      state.kind === "ready" &&
      (!restoreLocalMonitoring || monitoring)
    )
      void togglePlay();
  }, [mode, startReleased, state.kind, restoreLocalMonitoring, monitoring, togglePlay]);

  const controls = useKaraokeControls({
    position: positionRef,
    speed: speedRef,
    key: keyRef,
    monitoring,
    microphoneReady: capabilities.microphone === "ready",
    setPosition,
    setSpeed,
    setKeyShift,
    setGains,
    setMonitoring,
  });
  const updateKaraokeNoteScore = useCallback(
    (
      score: KaraokeNoteScore,
    ) => recordingCoordinator.updateKaraokeNoteScore(score),
    [],
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
    [controls, positionPolling],
  );

  // A take is recorded automatically whenever the song plays with a working microphone; a failed start is not retried.
  const startRecording = useCallback(async () => {
    const target = songRef.current;
    if (!target) return;
    const epoch = recordingEpoch.current;
    setRecording("starting");
    try {
      const free = (await pythonClient.diagnostics()).storage.free;
      if (epoch !== recordingEpoch.current) return;
      if (free < minimumRecordingBytes) {
        setRecording("failed");
        const choice = await askInsufficientDisk(ask, t, free);
        if (epoch === recordingEpoch.current && choice === "storage")
          openSettings("advanced");
        return;
      }
      await recordingCoordinator.start(target, {
        sourceSeconds: positionRef.current,
        playbackRate: speedRef.current,
        keyShift: keyRef.current,
      });
      if (epoch !== recordingEpoch.current) return;
      setRecording("recording");
    } catch {
      if (epoch !== recordingEpoch.current) return;
      setRecording("failed");
      notify(t("recordingFailed"), "error");
    }
  }, [ask, notify, openSettings, t]);

  useEffect(() => {
    if (
      state.kind === "playing" &&
      recording === "idle" &&
      capabilities.microphone === "ready"
    )
      void startRecording();
  }, [state.kind, recording, capabilities.microphone, startRecording]);

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

  return {
    load,
    state,
    position,
    pitchHz,
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
    setShowNotes: (value: boolean) =>
      updatePreferences({ karaokeShowNotes: value }),
    setShowLyrics: (value: boolean) =>
      updatePreferences({ karaokeShowLyrics: value }),
    setAutoHideConsole: (value: boolean) =>
      updatePreferences({ karaokeAutoHideConsole: value }),
    setEffectValues: (value: typeof preferences.karaokeEffects) =>
      updatePreferences({ karaokeEffects: value }),
    togglePlay,
    ...controls,
    seek,
    finishPerformance,
    confirmExit,
    updateKaraokeNoteScore,
  };
};
