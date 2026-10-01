import { measureAcousticLatency } from "./acousticLatency";
import { acceptClockSample, refreshNativeClock, type NativeClockSample } from "./nativeClock";
import type { AudioServiceClient } from "../contracts/clients";
import type {
  AudioConfigurationCapabilities,
  DeviceDto,
  PlaybackSnapshot,
  RequestedAudioConfiguration,
  SongDto,
} from "../contracts/models";
import { backendCode, backendName, parseDevices, parseKeyValues, roomTimingFromDiagnostics, runtimeConfigurationFromDiagnostics } from "./audioProtocol";
import { createAudioPlayers } from "./audioPlayers";
import { AudioReconfigurationState } from "./audioReconfiguration";
import { mixerGain } from "./mixerLevel";

const bridge = (): DesktopApi => {
  if (!window.desktop) throw new Error("Desktop bridge is unavailable");
  return window.desktop;
};

const command = async (
  name: string,
  args?: AudioBridgeRequest["args"],
): Promise<string> => {
  const response = await bridge().audioRequest({ command: name, args });
  if (response.status !== 0)
    throw new Error(response.text || `AudioService command failed: ${name}`);
  return response.text;
};

let preferred: RequestedAudioConfiguration = { backend: "WASAPI Shared", sampleRate: 0, periodFrames: 0 };

const numberList = (value: string | undefined): number[] =>
  (value ?? "").split(",").map(Number).filter(item => Number.isFinite(item) && item > 0);
const requestedFrames = (value: RequestedAudioConfiguration): number => value.backend === "WASAPI Shared"
    ? value.periodFrames
    : (value.bufferFrames ?? value.periodFrames);

let durationSeconds = 0;
let monitoring = false;
// The singer's own mute (the room's microphone button); it never changes the microphone's volume.
let microphoneEnabled = true;
const mutedParticipants = new Set<string>();
let recording = false;
let sessionId = crypto.randomUUID();
const dspParameters = new Map<string, number>();
let dspEnabled = false;
let activeVoiceSession: { roomId: string; participantId: string; serverClockOffsetMilliseconds?: number } | null = null;
// One server-owned deadline for backing audio and every remote voice in the active room.
let roomPlayoutDelayMilliseconds = 0;
// The session in which a manual measurement was accepted; the server rejects stale contexts.
let calibrationContext = "";
const remoteParticipantGains = new Map<string, number>();
type RemoteEffect = "reverb" | "echo" | "delay" | "noiseSuppression" | "octave" | "autoTune";
const remoteParticipantEffects = new Map<string, Map<RemoteEffect, number>>();
const reconfiguration = new AudioReconfigurationState();
const reconfigureAudio = (value: RequestedAudioConfiguration): Promise<string> => command("Reconfigure", {
  backend: backendCode(value.backend),
  input: value.inputDeviceId,
  output: value.outputDeviceId,
  rate: value.sampleRate,
  period: requestedFrames(value),
  inChannels: 0,
  outChannels: 0,
});
const rawDevices = async () => parseDevices(await command("GetDevices"));
let sessionStart: Promise<void> | null = null;

/** Concurrent callers share one start-up so two PrepareSession commands can never race each other. */
const ensureSession = (): Promise<void> => {
  sessionStart ??= startSession().finally(() => {
    sessionStart = null;
  });
  return sessionStart;
};

const startSession = async (): Promise<void> => {
  const values = await diagnostics();
  const state = values.SessionState;
  if (state === "Running") return;
  // A session prepared in another mode than the chosen one is prepared again, never started as is.
  const chosenMode = values.Backend === undefined || backendName(values.Backend) === preferred.backend;
  if (state === "Prepared" && chosenMode) return void (await command("StartSession"));
  // Preparing is only allowed from Idle, so a failed or half-open session is closed first.
  if (state !== "Idle") await command("StopSession");
  const devices = await rawDevices();
  // A saved device that disappeared is never replaced silently; an unset preference means the system default,
  // which AudioService resolves itself (the device list also holds inactive endpoints that must not be guessed).
  const find = (kind: DeviceDto["kind"], id: string | undefined) => {
    if (!id) return undefined;
    const device = devices.find((candidate) => candidate.id === id && candidate.kind === kind);
    if (!device) throw new Error(`Selected ${kind} device is unavailable`);
    return device;
  };
  const input = find("input", preferred.inputDeviceId);
  const output = find("output", preferred.outputDeviceId);
  await command("PrepareSession", {
    backend: backendCode(preferred.backend),
    input: input?.id,
    output: output?.id,
    rate: preferred.sampleRate,
    period: requestedFrames(preferred),
    inChannels: input?.channels || 0,
    outChannels: output?.channels || 0,
  });
  await command("StartSession");
  // A restarted AudioService knows none of the volumes and voice effects set before; they are
  // replayed so the new session sounds exactly like the knobs show.
  for (const [target, value] of reconfiguration.mixerGains) await command("SetGain", { target, value });
  for (const [name, value] of dspParameters) await command("SetDspParameter", { name, value });
  if (dspEnabled) await command("SetDspEnabled", { enabled: true });
  if (!microphoneEnabled) await command("SetMicrophoneEnabled", { enabled: false });
};

let nativeClock: NativeClockSample | undefined;
const refreshClock = async (): Promise<void> => {
  nativeClock = await refreshNativeClock(nativeClock, () => command("GetClock"));
};
const diagnostics = async (): Promise<Record<string, string>> => {
  const started = performance.now();
  const values = parseKeyValues(await command("GetDiagnostics"));
  const received = performance.now();
  nativeClock = acceptClockSample(nativeClock, Number(values.MonotonicTicks), started, received);
  return values;
};

const snapshot = async (
  forcedState?: PlaybackSnapshot["state"],
): Promise<PlaybackSnapshot> => {
  const values = await diagnostics();
  const sampleRate = Number(values.RuntimeOutputSampleRate || values.RequestedSampleRate || 0) || 0;
  const frames = Number(values.PlaybackPresentationPositionFrames ?? values.PlaybackPositionFrames ?? 0) || 0;
  const stateNumber = Number(values.PlaybackState ?? 2);
  const states: Record<number, PlaybackSnapshot["state"]> = { 3: "playing", 4: "paused", 6: "finished" };
  const state = forcedState ?? states[stateNumber] ?? "ready";
  return {
    sessionId,
    state,
    positionSeconds: sampleRate > 0 ? frames / sampleRate : 0,
    durationSeconds,
    recording,
    monitoring,
    inputLevel: Number(values.InputRMS || 0) || 0,
    pitchHz: Number(values.InputPitchHz || 0) || undefined,
  };
};

const waitForReady = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const values = await diagnostics();
    const state = Number(values.PlaybackState ?? 0);
    if (state === 2 || state === 3 || state === 4) return;
    if (state === 7) throw new Error("AudioService failed to load the song");
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
  throw new Error("AudioService song loading timed out");
};

const restoreRemoteParticipants = async (): Promise<void> => {
  for (const [participantId, gain] of remoteParticipantGains) {
    await command("AddRemoteParticipant", { participantId });
    await command("SetRemoteGain", { participantId, value: gain });
    for (const [effect, value] of remoteParticipantEffects.get(participantId) ?? [])
      await command("SetRemoteEffect", { participantId, effect, value });
    if (mutedParticipants.has(participantId)) await command("SetRemoteMute", { participantId, muted: true });
  }
};
const restoreVoiceSession = async (): Promise<void> => {
  const voice = activeVoiceSession;
  if (!voice) return;
  await ensureSession();
  await synchronizeRoomClock(voice.serverClockOffsetMilliseconds, true);
  await bridge().joinRoomVoice(voice.roomId, voice.participantId);
  await restoreRemoteParticipants();
  await command("SetRoomPlayoutDelay", { milliseconds: roomPlayoutDelayMilliseconds });
};
const synchronizeRoomClock = async (offset?: number, force = false): Promise<void> => {
  if (offset === undefined || !Number.isFinite(offset)) return;
  if (!force && activeVoiceSession?.serverClockOffsetMilliseconds === offset) return;
  await diagnostics();
  await refreshClock();
  if (!nativeClock) throw new Error("AudioService clock is unavailable");
  const now = performance.now();
  await command("SetRoomClock", {
    serverMicros: Math.round((now + offset) * 1000),
    localMicros: Math.round((now + nativeClock.offset) * 1000),
  });
  if (activeVoiceSession) activeVoiceSession.serverClockOffsetMilliseconds = offset;
};
const restoreMediaSession = (checkpoint: Awaited<ReturnType<typeof reconfiguration.checkpoint>>) =>
  reconfiguration.restore(checkpoint, dspParameters, dspEnabled, monitoring, {
    ensureSession,
    resolveArtifacts: song => bridge().resolveProjectArtifacts(song.id, song.activeRevision || 0),
    command,
    waitForReady,
    sampleRate: async () => {
      const values = await diagnostics();
      return Number(values.RuntimeOutputSampleRate || values.RequestedSampleRate || 0) || 0;
    },
  });
export const audioClient: AudioServiceClient = {
  async health() {
    try {
      const state = await command("GetServiceState");
      return {
        status: state === "Running" ? "ready" : "unavailable",
        version: "1",
      };
    } catch {
      return { status: "unavailable", version: "1" };
    }
  },

  async listDevices() {
    return (await rawDevices()).map(
      ({ backendIndex: _backendIndex, ...device }) => device,
    );
  },

  async capabilities() {
    const devices = await this.listDevices();
    return {
      microphone: devices.some((device) => device.kind === "input" && device.channels > 0)
        ? "ready"
        : "missing",
      keyboardLighting: false,
    };
  },

  async runtimeConfiguration() {
    return runtimeConfigurationFromDiagnostics(await diagnostics());
  },

  setPreferredConfiguration(configuration) {
    preferred = configuration;
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
    if (!(Number(values.AcousticPassiveAccepted) > 0) || values.Backend === undefined) return null;
    if (values.AcousticCalibrationValid !== "1" || !values.AcousticCalibrationContext) return null;
    return { milliseconds: Number(values.AcousticPassiveUs) / 1000, backend: backendName(values.Backend), context: values.AcousticCalibrationContext };
  },

  async measureAcousticLatency() {
    await ensureSession();
    const measured = await measureAcousticLatency((name) => command(name));
    await command("SetAcousticLatency", { ms: measured.milliseconds, context: measured.context });
    calibrationContext = measured.context;
    return measured.milliseconds;
  },

  async applyConfiguration(configuration) {
    const previous = preferred;
    const checkpoint = await reconfiguration.checkpoint(snapshot);
    preferred = configuration;
    try {
      await reconfigureAudio(configuration);
      await restoreVoiceSession();
      await restoreMediaSession(checkpoint);
      return await this.runtimeConfiguration();
    } catch (error) {
      preferred = previous;
      // Restore the previous complete audio graph before surfacing a rejected endpoint.
      await reconfigureAudio(previous);
      await restoreVoiceSession();
      await restoreMediaSession(checkpoint);
      throw error;
    }
  },

  async openBackendControlPanel(configuration) {
    await command("OpenBackendControlPanel", {
      backend: backendCode(configuration.backend),
      input: configuration.inputDeviceId,
      output: configuration.outputDeviceId,
      rate: configuration.sampleRate,
      period: requestedFrames(configuration),
      inChannels: 0,
      outChannels: 0,
    });
  },

  async configurationCapabilities(configuration): Promise<AudioConfigurationCapabilities> {
    const values = parseKeyValues(await command("GetAudioCapabilities", {
      backend: backendCode(configuration.backend),
      input: configuration.inputDeviceId,
      output: configuration.outputDeviceId,
      rate: configuration.sampleRate,
      period: requestedFrames(configuration),
      inChannels: 0,
      outChannels: 0,
    }));
    const defaultSampleRate = Number(values.defaultSampleRateHz) || 0;
    const reportedDefaultPeriodFrames = Number(values.defaultPeriodFrames) || 0;
    const sampleRates = numberList(values.sampleRatesHz);
    let periodFrames = numberList(values.periodFrames);
    if (periodFrames.length === 0) {
      const minimum = Number(values.minPeriodFrames) || reportedDefaultPeriodFrames;
      const maximum = Number(values.maxPeriodFrames) || reportedDefaultPeriodFrames;
      const step = Math.max(1, Number(values.fundamentalPeriodFrames) || 1);
      // Keep the select responsive even when a driver exposes a frame-by-frame interval.
      if (minimum > 0 && maximum >= minimum && (maximum - minimum) / step <= 256) {
        periodFrames = Array.from(
          { length: Math.floor((maximum - minimum) / step) + 1 },
          (_, index) => minimum + index * step,
        );
      }
    }
    if (defaultSampleRate > 0 && !sampleRates.includes(defaultSampleRate)) sampleRates.push(defaultSampleRate);
    const defaultPeriodFrames = reportedDefaultPeriodFrames;
    if (defaultPeriodFrames > 0 && !periodFrames.includes(defaultPeriodFrames))
      periodFrames.push(defaultPeriodFrames);
    return {
      sampleRates: sampleRates.sort((left, right) => left - right),
      periodFrames: periodFrames.sort((left, right) => left - right),
      defaultSampleRate,
      defaultPeriodFrames,
    };
  },

  async spectrum() {
    const values = parseKeyValues(await command("GetSpectrum"));
    const parseBands = (value: string | undefined) =>
      (value ?? "").split(",").map(Number).filter(Number.isFinite);
    return { bands: parseBands(values.bands), backingBands: parseBands(values.backingBands) };
  },

  diagnosticsDump: diagnostics,

  async testInputLevel() {
    await ensureSession();
    const values = parseKeyValues(await command("GetInputLevel"));
    return Number(values.rms ?? values.peak ?? 0) || 0;
  },

  async playTestSound() {
    await ensureSession();
    await command("PlayOutputTest");
  },

  async prepareSong(song: SongDto) {
    await ensureSession();
    const artifacts = await bridge().resolveProjectArtifacts(
      song.id,
      song?.activeRevision || 0,
    );
    await command("LoadSong", {
      instrumental: artifacts.instrumental,
      vocals: artifacts.vocals,
      melody: artifacts.melody,
    });
    durationSeconds = song.durationSeconds;
    reconfiguration.song = song;
    sessionId = crypto.randomUUID();
    await waitForReady();
    return snapshot("ready");
  },

  async play(schedule) {
    let args: AudioBridgeRequest["args"];
    if (schedule) {
      const values = await diagnostics();
      await refreshClock();
      if (!Number.isFinite(Number(values.MonotonicTicks)) || !nativeClock
        || !Number.isFinite(schedule.startAtMilliseconds) || !(Number(values.RuntimeOutputSampleRate) > 0))
        throw new Error("AudioService playback clock is unavailable");
      if (!Number.isFinite(schedule.positionSeconds)) throw new Error("Invalid playback position");
      args = {
        startAtTicks: Math.max(0, Math.round((schedule.startAtMilliseconds + nativeClock.offset) * 1e6)),
        frame: Math.max(0, Math.round(schedule.positionSeconds * Number(values.RuntimeOutputSampleRate))),
      };
    }
    await command("Play", args);
    return snapshot("playing");
  },

  async pause() {
    await command("Pause");
    return snapshot("paused");
  },

  async seek(positionSeconds) {
    const runtime = await this.runtimeConfiguration();
    await command("Seek", {
      frame: Math.max(0, Math.round(positionSeconds * runtime.sampleRate)),
    });
    return snapshot();
  },

  async stop() {
    await command("Stop");
    recording = false;
    reconfiguration.song = null;
    return snapshot("finished");
  },

  async setMonitoring(enabled) {
    if (enabled) {
      for (const [name, value] of dspParameters) await command("SetDspParameter", { name, value });
      await command("SetDspEnabled", { enabled: dspEnabled });
    }
    await command("SetMonitoring", { enabled });
    monitoring = enabled;
    return snapshot();
  },

  async setMixer(channel, position) {
    const gain = mixerGain(channel, position);
    reconfiguration.mixerGains.set(channel, gain);
    await command("SetGain", { target: channel, value: gain });
  },

  monitoringEnabled: () => monitoring,
  microphoneEnabled: () => microphoneEnabled,

  async setMicrophoneEnabled(enabled) {
    await command("SetMicrophoneEnabled", { enabled });
    microphoneEnabled = enabled;
  },

  async setParticipantMuted(participantId, muted) {
    await command("SetRemoteMute", { participantId, muted });
    if (muted) mutedParticipants.add(participantId);
    else mutedParticipants.delete(participantId);
  },
  participantMuted: participantId => mutedParticipants.has(participantId),

  async setParticipantVolume(participantId, gain) {
    remoteParticipantGains.set(participantId, gain);
    await command("SetRemoteGain", { participantId, value: gain });
  },

  async roomLevels() {
    const values = await diagnostics();
    const remote: Record<string, number> = {};
    for (const [name, value] of Object.entries(values)) {
      if (!name.startsWith("RemoteLevel.")) continue;
      remote[name.slice("RemoteLevel.".length)] = Number(value) || 0;
    }
    return { local: Number(values.InputRMS || 0) || 0, remote };
  },
  async setParticipantEffect(participantId, effect, value) {
    const effects = remoteParticipantEffects.get(participantId) ?? new Map<RemoteEffect, number>();
    effects.set(effect, value);
    remoteParticipantEffects.set(participantId, effects);
    await command("SetRemoteEffect", { participantId, effect, value });
  },

  async roomTiming() {
    return roomTimingFromDiagnostics(await diagnostics());
  },

  synchronizeRoomClock,

  async setRoomPlayoutDelay(milliseconds) {
    const bounded = Math.max(0, Math.min(160, milliseconds));
    if (bounded === roomPlayoutDelayMilliseconds) return;
    await command("SetRoomPlayoutDelay", { milliseconds: bounded });
    roomPlayoutDelayMilliseconds = bounded;
  },

  async joinVoiceSession(roomId, participantId, serverClockOffsetMilliseconds) {
    await ensureSession();
    // A session left running in another mode (an earlier start-up, device failure or rolled-back
    // switch) would carry the room on that mode's latency; the chosen mode is restored first.
    // If the device refuses it, the room still opens on the mode that works.
    const running = (await diagnostics()).Backend;
    if (running !== undefined && backendName(running) !== preferred.backend)
      await this.applyConfiguration(preferred).catch(() => undefined);
    await synchronizeRoomClock(serverClockOffsetMilliseconds, true);
    await bridge().joinRoomVoice(roomId, participantId);
    if (activeVoiceSession?.roomId !== roomId || activeVoiceSession.participantId !== participantId) {
      remoteParticipantGains.clear();
      remoteParticipantEffects.clear();
    }
    activeVoiceSession = { roomId, participantId, serverClockOffsetMilliseconds };
    await restoreRemoteParticipants();
  },

  async reconnectVoiceSession() {
    await restoreVoiceSession();
  },

  async leaveVoiceSession() {
    await bridge().leaveRoomVoice();
    activeVoiceSession = null;
    if (roomPlayoutDelayMilliseconds > 0)
      await command("SetRoomPlayoutDelay", { milliseconds: 0 });
    roomPlayoutDelayMilliseconds = 0;
    remoteParticipantGains.clear();
    remoteParticipantEffects.clear();
  },

  async addRemoteParticipant(participantId) {
    await command("AddRemoteParticipant", { participantId });
    if (!remoteParticipantGains.has(participantId)) remoteParticipantGains.set(participantId, 1);
  },

  async removeRemoteParticipant(participantId) {
    await command("RemoveRemoteParticipant", { participantId });
    remoteParticipantGains.delete(participantId);
    remoteParticipantEffects.delete(participantId);
  },

  async setPlaybackRate(rate) {
    reconfiguration.playbackRate = rate;
    await command("SetPlaybackRate", { value: rate });
  },

  async setPitchShift(semitones) {
    reconfiguration.pitchShift = semitones;
    await command("SetTranspose", { semitones });
  },

  async setDspParameter(name, value) {
    dspParameters.set(name, value);
    await command("SetDspParameter", { name, value });
  },

  async setDspEnabled(enabled) {
    dspEnabled = enabled;
    await command("SetDspEnabled", { enabled });
  },

  async startRecording() {
    recording = true;
    await command("StartRecording");
    return snapshot();
  },

  async stopRecording() {
    await command("StopRecording");
    recording = false;
    return snapshot();
  },

  ...createAudioPlayers({
    command,
    diagnostics,
    ensureSession,
    snapshot,
    pythonRequest: (request) => bridge().pythonRequest(request),
    sampleRate: async () => {
      const values = await diagnostics();
      return Number(values.RuntimeOutputSampleRate || values.RequestedSampleRate || 0) || 0;
    },
  }),
};

export const getAudioSnapshot = (): Promise<PlaybackSnapshot> => snapshot();
