import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useApp } from "../../app/AppContext";
import { useAsk } from "../../app/DialogProvider";
import { useCloseGuard } from "../../app/CloseGuards";
import { useNotify } from "../../app/NotificationsProvider";
import type { ProjectCompatibility } from "../../contracts/clients";
import type { AnalysisDto, AppError, AudioCapabilities, MixerChannelGains, SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";
import { recordingCoordinator } from "../../services/recordingCoordinator";
import { toAppError } from "../../shared/errors";
import { editorApi } from "../editor/editorApi";
import type { EditorDocument } from "../editor/editorModel";
import { loadSongPreferences, type SongPreferences } from "../library/songPreferences";
import { reduceKaraoke, type KaraokeState } from "./karaokeMachine";
import { resolveKaraokeLoad, type KaraokeLoad } from "./karaokeLoader";
import { askInsufficientDisk, minimumRecordingBytes } from "./askInsufficientDisk";
import { useAudioRecovery } from "./useAudioRecovery";
import { useKaraokeControls } from "./useKaraokeControls";
import { usePositionPolling } from "./usePositionPolling";

export type KaraokeOpenMode = "Normal" | "AutoStart" | "RoomPrepared";

export type { KaraokeLoad };

/** The guide vocal starts at half volume; the level shown on its knob is also sent to AudioService when the song is prepared. */
const referenceGain = 0.5;

export type RecordingUiState = "idle" | "starting" | "recording" | "stopping" | "failed";

const noMicrophone: AudioCapabilities = { microphone: "missing", keyboardLighting: false };

export const useKaraokeSession = (songId: string, mode: KaraokeOpenMode, startReleased: boolean) => {
  const { preferences, updatePreferences, openSettings } = useApp();
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();

  const [load, setLoad] = useState<KaraokeLoad>({ kind: "loading" });
  const [state, dispatch] = useReducer(reduceKaraoke, { kind: "preparing" } as KaraokeState);
  const [position, setPosition] = useState(0);
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [songPrefs, setSongPrefs] = useState<SongPreferences | null>(null);
  const [capabilities, setCapabilities] = useState<AudioCapabilities>(noMicrophone);
  const [speed, setSpeed] = useState(1);
  const [keyShift, setKeyShift] = useState(0);
  const [monitoring, setMonitoring] = useState(false);
  const [recording, setRecording] = useState<RecordingUiState>("idle");
  const [recordingId, setRecordingId] = useState<string | undefined>();
  const [recoveredNotice, setRecoveredNotice] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisDto | null>(null);
  const initialGains = useRef<MixerChannelGains>({ music: preferences.musicGain, mic: preferences.voiceGain, reference: referenceGain });
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
  const song = load.kind === "ready" ? load.song : null;
  const songRef = useRef<SongDto | null>(null);
  songRef.current = song;

  const fail = useCallback((error: unknown) => dispatch({ type: "FAIL", error: toAppError(error) satisfies AppError }), []);

  // ---- loading: identity, project compatibility, editor document, audio session ----
  useEffect(() => {
    let active = true;
    setLoad({ kind: "loading" });
    dispatch({ type: "RESTART" });
    void (async () => {
      const resolved = await resolveKaraokeLoad(songId);
      if (!active) return;
      setLoad(resolved.load);
      if (resolved.load.kind !== "ready" || !resolved.prefs) return;
      const loaded = resolved.load.song;
      const prefs = resolved.prefs;
      setSongPrefs(prefs);
      setSpeed(prefs.defaultSpeed);
      setKeyShift(prefs.defaultKey);
      // Missing lyrics/notes are a content fallback, not a failure.
      setDocument(await editorApi.load(loaded.id).catch(() => null));
      try {
        setCapabilities(await audioClient.capabilities().catch(() => noMicrophone));
        await audioClient.prepareSong(loaded);
        await audioClient.setPlaybackRate(prefs.defaultSpeed);
        await audioClient.setPitchShift(prefs.defaultKey);
        await audioClient.setMixer("music", initialGains.current.music);
        await audioClient.setMixer("mic", initialGains.current.mic);
        await audioClient.setMixer("reference", initialGains.current.reference);
        if (!active) return;
        dispatch({ type: "PREPARED" });
      } catch (error) {
        if (active) fail(error);
      }
    })();
    return () => {
      active = false;
    };
    // Initial gains are read once at open; later changes flow through the mixer handlers.
  }, [songId, mode, fail]);

  // ---- finishing a performance: EOF and Stop share one path so recording is always finalized ----
  const finishPerformance = useCallback(async () => {
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
    dispatch({ type: "FINISH" });
    if (takeId) setAnalysis(await pythonClient.latestAnalysis(takeId).catch(() => null));
  }, [notify, t]);

  const isPollable = useCallback(() => ["playing", "paused", "ready"].includes(stateRef.current.kind), []);
  const isPlaying = useCallback(() => stateRef.current.kind === "playing", []);
  const onPosition = useCallback((seconds: number) => {
    positionRef.current = seconds;
    setPosition(seconds);
  }, []);
  const onLost = useCallback(() => dispatch({ type: "AUDIO_LOST" }), []);
  const onFinished = useCallback(() => void finishPerformance(), [finishPerformance]);
  usePositionPolling({
    enabled: load.kind === "ready",
    isPollable,
    isPlaying,
    onPosition,
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

  // ---- leaving: nothing may keep playing or recording after the route closes ----
  useEffect(
    () => () => {
      void audioClient.stop().catch(() => undefined);
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

  const locked = recording === "recording" || recording === "starting";
  const interactive = state.kind === "ready" || state.kind === "playing" || state.kind === "paused";

  const togglePlay = useCallback(async () => {
    setRecoveredNotice(false);
    try {
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
  }, [fail]);

  const resume = togglePlay;

  // Opened from the library, the performance starts on its own once the opening scene releases it.
  useEffect(() => {
    if (mode === "AutoStart" && startReleased && state.kind === "ready") void togglePlay();
  }, [mode, startReleased, state.kind, togglePlay]);

  const controls = useKaraokeControls({
    recording: recordingRef,
    position: positionRef,
    key: keyRef,
    monitoring,
    microphoneReady: capabilities.microphone === "ready",
    setPosition,
    setSpeed,
    setKeyShift,
    setGains,
    setMonitoring
  });

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
      await recordingCoordinator.start(target);
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
    locked,
    interactive,
    showNotes: preferences.karaokeShowNotes,
    showLyrics: preferences.karaokeShowLyrics,
    autoHideConsole: preferences.karaokeAutoHideConsole,
    noiseSuppression: preferences.noiseSuppression,
    setShowNotes: (value: boolean) => updatePreferences({ karaokeShowNotes: value }),
    setShowLyrics: (value: boolean) => updatePreferences({ karaokeShowLyrics: value }),
    setAutoHideConsole: (value: boolean) => updatePreferences({ karaokeAutoHideConsole: value }),
    togglePlay,
    resume,
    ...controls,
    finishPerformance,
    confirmExit
  };
};
