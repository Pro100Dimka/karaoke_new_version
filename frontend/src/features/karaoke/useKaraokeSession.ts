import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useApp } from "../../app/AppContext";
import { useAsk } from "../../app/DialogProvider";
import { useCloseGuard } from "../../app/CloseGuards";
import { useNotify } from "../../app/NotificationsProvider";
import type { AnalysisDto, AppError, MixerChannelGains, SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";
import { roomClient } from "../../services/roomClient";
import { recordingCoordinator } from "../../services/recordingCoordinator";
import { toAppError } from "../../shared/errors";
import { reduceKaraoke, type KaraokeState } from "./karaokeMachine";
import type { KaraokeLoad } from "./karaokeLoader";
import { askInsufficientDisk, minimumRecordingBytes } from "./askInsufficientDisk";
import { useAudioRecovery } from "./useAudioRecovery";
import { useKaraokeControls } from "./useKaraokeControls";
import { releaseKaraokeAudio } from "./karaokeAudioLifecycle";
import { usePositionPolling } from "./usePositionPolling";
import { ensurePerformanceAnalysis } from "./performanceAnalysis";
import { roomSelectionEnded, roomToggleCommand } from "./roomPlayback";
import { useKeyboardLighting } from "./useKeyboardLighting";
import { useKaraokeLoadSession } from "./useKaraokeLoadSession";
import { useSynchronizedRoomPlayback } from "./useSynchronizedRoomPlayback";

export type KaraokeOpenMode = "Normal" | "AutoStart" | "RoomPrepared";

export type { KaraokeLoad };

export type RecordingUiState = "idle" | "starting" | "recording" | "stopping" | "failed";

export const useKaraokeSession = (songId: string, mode: KaraokeOpenMode, startReleased: boolean) => {
  const { preferences, updatePreferences, openSettings, room, setRoom } = useApp();
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();

  const [state, dispatch] = useReducer(reduceKaraoke, { kind: "preparing" } as KaraokeState);
  const [position, setPosition] = useState(0);
  const [pitchHz, setPitchHz] = useState<number | undefined>();
  const [speed, setSpeed] = useState(1);
  const [keyShift, setKeyShift] = useState(0);
  const [monitoring, setMonitoring] = useState(false);
  const [recording, setRecording] = useState<RecordingUiState>("idle");
  const [recordingId, setRecordingId] = useState<string | undefined>();
  const [recoveredNotice, setRecoveredNotice] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisDto | null>(null);
  const initialGains = useRef<MixerChannelGains>({
    music: preferences.musicGain,
    mic: preferences.voiceGain,
    reference: preferences.referenceGain,
    melody: preferences.melodyGain,
  });
  const [gains, setGains] = useState<MixerChannelGains>(initialGains.current);

  const stateRef = useRef(state);
  stateRef.current = state;
  const positionRef = useRef(0);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const keyRef = useRef(keyShift);
  keyRef.current = keyShift;

  const fail = useCallback((error: unknown) => dispatch({ type: "FAIL", error: toAppError(error) satisfies AppError }), []);
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
  const song = load.kind === "ready" ? load.song : null;
  const songRef = useRef<SongDto | null>(null);
  songRef.current = song;

  // ---- finishing a performance: EOF and Stop share one path so recording is always finalized ----
  const finishLocalPerformance = useCallback(async () => {
    dispatch({ type: "STOPPING" });
    let takeId: string | undefined;
    if (recordingRef.current === "recording") {
      setRecording("stopping");
      try {
        takeId = (await recordingCoordinator.stop()).recordingId;
        setRecordingId(takeId);
        notify(t("recordingSaved"), "success");
      } catch {
        setRecording("failed");
        notify(t("recordingFailed"), "error");
      }
    }
    await audioClient.stop().catch(() => undefined);
    setRecording(current => (current === "failed" ? current : "idle"));
    if (takeId) {
      setAnalysis(
        await ensurePerformanceAnalysis(takeId, pythonClient).catch(() => null),
      );
    }
    dispatch({ type: "FINISH" });
  }, [notify, t]);

  const finishPerformance = useCallback(async () => {
    if (room) {
      if (room.role !== "host" && !room.collaborativeControl) return;
      try {
        setRoom(await roomClient.roomControl(room.code, "Stop"));
      } catch (error) {
        fail(error);
        return;
      }
      await finishLocalPerformance();
      try {
        setRoom(await roomClient.clearRoomSong(room.code));
      } catch (error) {
        fail(error);
      }
      return;
    }
    await finishLocalPerformance();
  }, [room, setRoom, fail, finishLocalPerformance]);

  // A synchronized Back/Stop must finalize the local take before this route disappears. RoomSync
  // deliberately leaves navigation to this shared solo lifecycle so analysis and exit animation run.
  useEffect(() => {
    if (roomSelectionEnded(mode, room?.songId, state.kind)) void finishLocalPerformance();
  }, [mode, room?.songId, state.kind, finishLocalPerformance]);

  const isPollable = useCallback(() => ["playing", "paused", "ready"].includes(stateRef.current.kind), []);
  const isPlaying = useCallback(() => stateRef.current.kind === "playing", []);
  const onPosition = useCallback((seconds: number) => {
    positionRef.current = seconds;
    setPosition(seconds);
  }, []);
  const onAudioSnapshot = useCallback((snapshot: { pitchHz?: number }) => setPitchHz(snapshot.pitchHz), []);
  const onLost = useCallback(() => dispatch({ type: "AUDIO_LOST" }), []);
  const onFinished = useCallback(() => void finishPerformance(), [finishPerformance]);
  const positionPolling = usePositionPolling({
    enabled: load.kind === "ready",
    isPollable,
    isPlaying,
    onPosition,
    onSnapshot: onAudioSnapshot,
    onFinished,
    onLost
  });

  const onRecovered = useCallback(() => {
    setRecoveredNotice(true);
    setMonitoring(false);
    setRecording(current => (current === "recording" ? "failed" : current));
    dispatch({ type: "AUDIO_RECOVERED" });
  }, []);
  useAudioRecovery({
    recovering: state.kind === "recovering",
    song: songRef,
    position: positionRef,
    speed: speedRef,
    key: keyRef,
    onRecovered
  });
  useKeyboardLighting(preferences.keyboardLighting, preferences.theme, position, state.kind === "playing");

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
      audioClient.setPitchShift(nextKey)
    ]).catch(fail);
  }, [room?.code, room?.playbackRate, room?.keyShift, load.kind, fail]);

  // ---- leaving: nothing may keep playing or recording after the route closes ----
  useEffect(
    () => () => {
      void releaseKaraokeAudio();
    },
    []
  );

  const confirmExit = useCallback(async (): Promise<boolean> => {
    if (recordingRef.current !== "recording") return true;
    const choice = await ask({
      title: t("leaveWhileRecordingTitle"),
      body: t("leaveWhileRecordingBody"),
      actions: [
        { id: "cancel", label: t("cancel") },
        { id: "save", label: t("stopAndSave"), appearance: "primary" }
      ]
    });
    if (choice !== "save") return false;
    await finishPerformance();
    return true;
  }, [ask, finishPerformance, t]);

  useCloseGuard(confirmExit);

  const interactive = state.kind === "ready" || state.kind === "playing" || state.kind === "paused";

  const togglePlay = useCallback(async () => {
    setRecoveredNotice(false);
    try {
      if (room) {
        const command = roomToggleCommand(room);
        if (command) setRoom(await roomClient.roomControl(room.code, command));
        return;
      }
      if (stateRef.current.kind === "playing") {
        await audioClient.pause();
        dispatch({ type: "PAUSE" });
      } else if (stateRef.current.kind === "ready" || stateRef.current.kind === "paused") {
        await audioClient.play();
        dispatch({ type: "PLAY" });
      }
    } catch (error) {
      fail(error);
    }
  }, [room, setRoom, fail]);

  const onRoomPlaybackEvent = useCallback((event: "PLAY" | "PAUSE") => dispatch({ type: event }), []);
  useSynchronizedRoomPlayback({
    room,
    ready: load.kind === "ready",
    stateKind: state.kind,
    position: positionRef,
    onEvent: onRoomPlaybackEvent,
    onFinished: finishLocalPerformance,
    onFailure: fail,
  });

  const resume = togglePlay;

  // Opened from the library, the performance starts on its own once the opening scene releases it.
  useEffect(() => {
    if (mode === "AutoStart" && startReleased && state.kind === "ready") void togglePlay();
  }, [mode, startReleased, state.kind, togglePlay]);

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
    setMonitoring
  });
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
    [controls, positionPolling]
  );

  // A take is recorded automatically whenever the song plays with a working microphone; a failed start is not retried.
  const startRecording = useCallback(async () => {
    const target = songRef.current;
    if (!target) return;
    setRecording("starting");
    try {
      const free = (await pythonClient.diagnostics()).storage.free;
      if (free < minimumRecordingBytes) {
        setRecording("failed");
        if ((await askInsufficientDisk(ask, t, free)) === "storage") openSettings("advanced");
        return;
      }
      await recordingCoordinator.start(target, {
        sourceSeconds: positionRef.current,
        playbackRate: speedRef.current,
        keyShift: keyRef.current
      });
      setRecording("recording");
    } catch {
      setRecording("failed");
      notify(t("recordingFailed"), "error");
    }
  }, [ask, notify, openSettings, t]);

  useEffect(() => {
    if (state.kind === "playing" && recording === "idle" && capabilities.microphone === "ready") void startRecording();
  }, [state.kind, recording, capabilities.microphone, startRecording]);

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
    analysis,
    gains,
    interactive,
    practiceLocked: Boolean(room && ((room.role !== "host" && !room.collaborativeControl) || room.playbackLocked)),
    showNotes: preferences.karaokeShowNotes,
    showLyrics: preferences.karaokeShowLyrics,
    autoHideConsole: preferences.karaokeAutoHideConsole,
    noiseSuppression: preferences.noiseSuppression,
    effectValues: preferences.karaokeEffects,
    setShowNotes: (value: boolean) => updatePreferences({ karaokeShowNotes: value }),
    setShowLyrics: (value: boolean) => updatePreferences({ karaokeShowLyrics: value }),
    setAutoHideConsole: (value: boolean) => updatePreferences({ karaokeAutoHideConsole: value }),
    setEffectValues: (value: typeof preferences.karaokeEffects) => updatePreferences({ karaokeEffects: value }),
    togglePlay,
    resume,
    ...controls,
    seek,
    finishPerformance,
    confirmExit
  };
};
