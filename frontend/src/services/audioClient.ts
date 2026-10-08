import { desktopBridge } from "./desktopBridge";
import { measureAcousticLatency } from "./acousticLatency";
import type { AudioServiceClient, PlaybackSchedule } from "../contracts/clients";
import { unverifiedAsioMonitoring, type PlaybackSnapshot, type RequestedAudioConfiguration } from "../contracts/models";
import {
  audioCapabilitiesFromValues,
  backendName,
  diagnosticNumber,
  parseKeyValues,
  runtimeConfigurationFromDiagnostics,
} from "./audioProtocol";
import { createAudioPlayers } from "./audioPlayers";
import type { MediaCheckpoint } from "./audioReconfiguration";
import { mixerGain } from "./mixerLevel";
import {
  audioClock,
  audioState,
  command,
  currentSampleRate,
  diagnostics,
  endpointArgs,
  endpointsAvailable,
  ensureSession,
  rawDevices,
  refreshClock,
  snapshot,
  waitForReady,
} from "./audioSession";
import { isAsio4AllRoute, safeAudioConfiguration } from "../shared/preferences/preferences";
import { createRoomVoice, restoreVoiceSession } from "./audioRoomVoice";

// The session in which a manual measurement was accepted; the server rejects stale contexts.
let calibrationContext = "";

const configurationEndpointsAvailable = async (
  configuration: RequestedAudioConfiguration,
): Promise<boolean> => {
  if (!configuration.inputDeviceId && !configuration.outputDeviceId) return true;
  return endpointsAvailable(await rawDevices(), configuration);
};

const restoreMediaSession = (checkpoint: MediaCheckpoint | null) =>
  audioState.reconfiguration.restore(
    checkpoint,
    audioState.dspParameters,
    audioState.dspEnabled,
    audioState.monitoring,
    {
      ensureSession,
      resolveArtifacts: (song) => desktopBridge().resolveProjectArtifacts(song.id, song.activeRevision),
      command,
      waitForReady,
      sampleRate: currentSampleRate,
    },
  );

/** Switches AudioService to a configuration and brings back the room voice and the loaded song. */
const activateConfiguration = async (
  configuration: RequestedAudioConfiguration,
  checkpoint: MediaCheckpoint | null,
): Promise<void> => {
  await command("Reconfigure", endpointArgs(configuration));
  audioState.active = configuration;
  await ensureSession();
  await restoreVoiceSession();
  await restoreMediaSession(checkpoint);
};

/** Where AudioService starts a scheduled song: its clock ticks and the first frame. */
const scheduledStart = async (schedule: PlaybackSchedule): Promise<AudioBridgeRequest["args"]> => {
  const values = await diagnostics();
  await refreshClock();
  const clock = audioClock();
  const sampleRate = Number(values.RuntimeOutputSampleRate);
  if (
    !Number.isFinite(Number(values.MonotonicTicks)) ||
    !clock ||
    !Number.isFinite(schedule.startAtMilliseconds) ||
    !(sampleRate > 0)
  )
    throw new Error("AudioService playback clock is unavailable");
  if (!Number.isFinite(schedule.positionSeconds)) throw new Error("Invalid playback position");
  return {
    startAtTicks: Math.max(0, Math.round((schedule.startAtMilliseconds + clock.offset) * 1e6)),
    frame: Math.max(0, Math.round(schedule.positionSeconds * sampleRate)),
  };
};

const parseBands = (value: string | undefined): number[] =>
  (value ?? "").split(",").map(Number).filter(Number.isFinite);

export const audioClient: AudioServiceClient = {
  snapshot,
  async health() {
    try {
      const state = await command("GetServiceState");
      return { status: state === "Running" ? "ready" : "unavailable", version: "1" };
    } catch {
      return { status: "unavailable", version: "1" };
    }
  },

  async listDevices() {
    return (await rawDevices()).map(({ backendIndex: _backendIndex, ...device }) => device);
  },

  async capabilities() {
    const devices = await this.listDevices();
    const hasMicrophone = devices.some((device) => device.kind === "input" && device.channels > 0);
    return { microphone: hasMicrophone ? "ready" : "missing", keyboardLighting: false };
  },

  async runtimeConfiguration() {
    return runtimeConfigurationFromDiagnostics(await diagnostics());
  },

  setPreferredConfiguration(configuration) {
    audioState.preferred = configuration;
  },

  preferredConfiguration() {
    return { ...audioState.preferred };
  },

  async suspendSession() {
    await command("SuspendSession");
  },

  async resumeSession() {
    await command("ResumeSession");
  },

  async setAcousticLatency(milliseconds, context = calibrationContext) {
    await command("SetAcousticLatency", { ms: milliseconds, context });
  },

  async passiveAcousticLatency() {
    const values = await diagnostics();
    const { Backend: backend, AcousticCalibrationContext: context } = values;
    if (!(Number(values.AcousticPassiveAccepted) > 0) || backend === undefined) return null;
    if (values.AcousticCalibrationValid !== "1" || !context) return null;
    return {
      milliseconds: Number(values.AcousticPassiveUs) / 1000,
      backend: backendName(backend),
      context,
    };
  },

  async measureAcousticLatency() {
    await ensureSession();
    const measured = await measureAcousticLatency((name) => command(name));
    await command("SetAcousticLatency", { ms: measured.milliseconds, context: measured.context });
    calibrationContext = measured.context;
    return measured.milliseconds;
  },

  async applyConfiguration(configuration) {
    configuration = safeAudioConfiguration(configuration, await rawDevices());
    // Reconfigure is destructive inside AudioService: it closes the active backend before opening
    // the replacement. Reject a device that Windows no longer enumerates before touching the
    // working session, so a temporary USB/driver disappearance cannot silence an active room.
    if (!(await configurationEndpointsAvailable(configuration)))
      throw new Error(`${configuration.backend} device is unavailable`);
    const previous = audioState.active;
    const checkpoint = await audioState.reconfiguration.checkpoint(snapshot);
    audioState.preferred = configuration;
    try {
      await activateConfiguration(configuration, checkpoint);
      return await this.runtimeConfiguration();
    } catch (error) {
      audioState.preferred = previous;
      // Restore the previous complete audio graph before surfacing a rejected endpoint.
      await activateConfiguration(previous, checkpoint);
      throw error;
    }
  },

  async openBackendControlPanel(configuration) {
    await command("OpenBackendControlPanel", endpointArgs(configuration));
  },

  async configurationCapabilities(configuration) {
    const values = parseKeyValues(await command("GetAudioCapabilities", endpointArgs(configuration)));
    return audioCapabilitiesFromValues(values, configuration.backend);
  },

  async spectrum() {
    const values = parseKeyValues(await command("GetSpectrum"));
    return { bands: parseBands(values.bands), backingBands: parseBands(values.backingBands) };
  },

  diagnosticsDump: diagnostics,

  async testInputLevel() {
    await ensureSession();
    const values = parseKeyValues(await command("GetInputLevel"));
    return diagnosticNumber(values.rms ?? values.peak);
  },

  async playTestSound() {
    await ensureSession();
    await command("PlayOutputTest");
  },

  async prepareSong(song) {
    await ensureSession();
    const artifacts = await desktopBridge().resolveProjectArtifacts(song.id, song.activeRevision);
    await command("LoadSong", {
      instrumental: artifacts.instrumental,
      vocals: artifacts.vocals,
      melody: artifacts.melody,
    });
    audioState.durationSeconds = song.durationSeconds;
    audioState.reconfiguration.song = song;
    audioState.sessionId = crypto.randomUUID();
    await waitForReady();
    return snapshot("ready");
  },

  async play(schedule) {
    await command("Play", schedule ? await scheduledStart(schedule) : undefined);
    return snapshot("playing");
  },

  async pause() {
    await command("Pause");
    return snapshot("paused");
  },

  async seek(positionSeconds) {
    const runtime = await this.runtimeConfiguration();
    await command("Seek", { frame: Math.max(0, Math.round(positionSeconds * runtime.sampleRate)) });
    return snapshot();
  },

  async stop() {
    await command("Stop");
    // A stopped song stays loaded otherwise, and its open files keep Windows from deleting or moving it.
    await command("UnloadSong");
    audioState.recording = false;
    audioState.reconfiguration.song = null;
    return snapshot("finished");
  },

  async setMonitoring(enabled) {
    if (enabled && audioState.active.backend === "ASIO" &&
      isAsio4AllRoute(audioState.active, await rawDevices()))
      throw new Error(unverifiedAsioMonitoring);
    if (enabled) {
      for (const [name, value] of audioState.dspParameters)
        await command("SetDspParameter", { name, value });
      await command("SetDspEnabled", { enabled: audioState.dspEnabled });
    }
    await command("SetMonitoring", { enabled });
    audioState.monitoring = enabled;
    return snapshot();
  },

  async setMixer(channel, position) {
    const gain = mixerGain(channel, position);
    audioState.reconfiguration.mixerGains.set(channel, gain);
    await command("SetGain", { target: channel, value: gain });
  },

  monitoringEnabled: () => audioState.monitoring,
  microphoneEnabled: () => audioState.microphoneEnabled,

  async setMicrophoneEnabled(enabled) {
    await command("SetMicrophoneEnabled", { enabled });
    audioState.microphoneEnabled = enabled;
  },

  ...createRoomVoice((configuration) => audioClient.applyConfiguration(configuration)),

  async setPlaybackRate(rate) {
    audioState.reconfiguration.playbackRate = rate;
    await command("SetPlaybackRate", { value: rate });
  },

  async setPitchShift(semitones) {
    audioState.reconfiguration.pitchShift = semitones;
    await command("SetTranspose", { semitones });
  },

  async setDspParameter(name, value) {
    audioState.dspParameters.set(name, value);
    await command("SetDspParameter", { name, value });
  },

  async setDspEnabled(enabled) {
    audioState.dspEnabled = enabled;
    await command("SetDspEnabled", { enabled });
  },

  async startRecording() {
    audioState.recording = true;
    await command("StartRecording");
    return snapshot();
  },

  async stopRecording() {
    await command("StopRecording");
    audioState.recording = false;
    return snapshot();
  },

  ...createAudioPlayers({
    command,
    diagnostics,
    ensureSession,
    snapshot,
    pythonRequest: (request) => desktopBridge().pythonRequest(request),
    sampleRate: currentSampleRate,
  }),
};

export const getAudioSnapshot = (): Promise<PlaybackSnapshot> => snapshot();

// The automated Electron room test must exercise this exact production lifecycle rather than
// reconstructing join/rejoin calls in Playwright. The hook is absent from ordinary app sessions.
if (window.desktop?.roomE2e)
  window.roomE2eReconnectVoiceSession = () => audioClient.reconnectVoiceSession();
