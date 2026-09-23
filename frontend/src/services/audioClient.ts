import type { AudioServiceClient } from "../contracts/clients";
import type {
  DeviceDto,
  PlaybackSnapshot,
  RequestedAudioConfiguration,
  RuntimeAudioConfiguration,
  SongDto,
} from "../contracts/models";
import { backendCode, backendName, parseDevices, parseKeyValues, roomTimingFromDiagnostics } from "./audioProtocol";

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

let preferred: RequestedAudioConfiguration = { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 256 };

let durationSeconds = 0;
let monitoring = false;
let recording = false;
let sessionId = crypto.randomUUID();
const dspParameters = new Map<string, number>();
let dspEnabled = false;
let activeVoiceSession: { roomId: string; participantId: string } | null = null;
const remoteParticipantGains = new Map<string, number>();

const reconfigureAudio = (value: RequestedAudioConfiguration): Promise<string> => command("Reconfigure", {
  backend: backendCode(value.backend),
  input: value.inputDeviceId,
  output: value.outputDeviceId,
  rate: value.sampleRate,
  period: value.periodFrames,
  inChannels: 1,
  outChannels: 2,
});

// A true exclusive render endpoint cannot coexist with another singer on the same Windows device.
// Rooms therefore keep shared capture/render underneath while retaining the user's Exclusive
// preference, which is restored when the room voice session ends.
const roomSafeConfiguration = (
  value: RequestedAudioConfiguration,
): RequestedAudioConfiguration => activeVoiceSession && value.backend === "WASAPI Exclusive"
  ? { ...value, backend: "WASAPI Shared" }
  : value;

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
  const state = (await diagnostics()).SessionState;
  if (state === "Running") return;
  if (state === "Prepared") return void (await command("StartSession"));
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
    period: preferred.periodFrames,
    inChannels: input?.channels || 1,
    outChannels: output?.channels || 2,
  });
  await command("StartSession");
};

const diagnostics = async (): Promise<Record<string, string>> =>
  parseKeyValues(await command("GetDiagnostics"));

const snapshot = async (
  forcedState?: PlaybackSnapshot["state"],
): Promise<PlaybackSnapshot> => {
  const values = await diagnostics();
  const sampleRate =
    Number(
      values.RuntimeOutputSampleRate || values.RequestedSampleRate || 48000,
    ) || 48000;
  const frames = Number(values.PlaybackPositionFrames || 0) || 0;
  const stateNumber = Number(values.PlaybackState ?? 2);
  const state: PlaybackSnapshot["state"] =
    forcedState ??
    (stateNumber === 3
      ? "playing"
      : stateNumber === 4
        ? "paused"
        : stateNumber === 6
          ? "finished"
          : "ready");
  return {
    sessionId,
    state,
    positionSeconds: frames / sampleRate,
    durationSeconds,
    recording,
    monitoring,
    inputLevel: Number(values.InputRMS || 0) || 0,
  };
};

// PlaybackState numbers reported for the recording preview slot: 2 Ready, 3 Playing, 4 Paused, 6 Finished, 7 Failed.
const readyStateNumber = 2;
const finishedStateNumber = "6";
const previewStates: Record<number, "ready" | "playing" | "paused" | "finished"> = { 2: "ready", 3: "playing", 4: "paused", 6: "finished" };
let previewRecordingId: string | null = null;
const previewValues = (): Promise<Record<string, string>> => diagnostics();

const waitForPreviewReady = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = Number((await previewValues()).PreviewState ?? 0);
    if (state === 7) throw new Error("AudioService failed to load the recording");
    if (state === readyStateNumber || state === 3 || state === 4) return;
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
  throw new Error("AudioService recording loading timed out");
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

// PlaybackState values reported by AudioService: 2 Ready, 7 Failed.
const radioReadyState = 2;
const radioFailedState = 7;
const radioPollMilliseconds = 100;
const radioPollAttempts = 100;

const waitForRadioReady = async (): Promise<void> => {
  for (let attempt = 0; attempt < radioPollAttempts; attempt += 1) {
    const state = Number((await diagnostics()).RadioState ?? 0);
    if (state === radioReadyState) return;
    if (state === radioFailedState) throw new Error("AudioService could not open the radio stream");
    await new Promise((resolve) => window.setTimeout(resolve, radioPollMilliseconds));
  }
  throw new Error("AudioService radio stream timed out");
};

const restoreVoiceSession = async (): Promise<void> => {
  const voice = activeVoiceSession;
  if (!voice) return;
  await ensureSession();
  await bridge().joinRoomVoice(voice.roomId, voice.participantId);
  for (const [participantId, gain] of remoteParticipantGains) {
    await command("AddRemoteParticipant", { participantId });
    await command("SetRemoteGain", { participantId, value: gain });
  }
};

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
      microphone: devices.some((device) => device.kind === "input")
        ? "ready"
        : "missing",
      keyboardLighting: false,
    };
  },

  async runtimeConfiguration() {
    const values = await diagnostics();
    const sampleRate =
      Number(
        values.RuntimeOutputSampleRate || values.RequestedSampleRate || 48000,
      ) || 48000;
    const periodFrames = Number(values.RuntimeOutputPeriodFrames || 256) || 256;
    const latencyFrames = Number(values.EstimatedLatencyFrames || 0) || 0;
    return {
      backend: backendName(values.Backend ?? "WASAPI Shared"),
      sampleRate,
      periodFrames,
      endpointBufferFrames: Number(values.RenderPaddingFrames || 0) || 0,
      estimatedLatencyMs:
        sampleRate > 0 ? (latencyFrames * 1000) / sampleRate : 0,
    };
  },

  setPreferredConfiguration(configuration) {
    preferred = configuration;
  },

  async applyConfiguration(configuration) {
    const previous = preferred;
    preferred = configuration;
    try {
      await reconfigureAudio(roomSafeConfiguration(configuration));
      await restoreVoiceSession();
      return await this.runtimeConfiguration();
    } catch (error) {
      preferred = previous;
      // Reconfigure tears down both the hardware backend and the UDP room engine. If the new
      // endpoint is busy (common when another local instance owns it exclusively), put the last
      // known-good backend back and re-register voice before surfacing the rejected setting.
      await reconfigureAudio(roomSafeConfiguration(previous));
      await restoreVoiceSession();
      throw error;
    }
  },

  async spectrum() {
    const values = parseKeyValues(await command("GetSpectrum"));
    return (values.bands ?? "").split(",").map(Number).filter(Number.isFinite);
  },

  async diagnosticsDump() {
    return diagnostics();
  },

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
    sessionId = crypto.randomUUID();
    await waitForReady();
    return snapshot("ready");
  },

  async play() {
    await command("Play");
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

  async setMixer(channel, gain) {
    await command("SetGain", { target: channel, value: gain });
  },

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

  async roomTiming() {
    return roomTimingFromDiagnostics(await diagnostics());
  },

  async joinVoiceSession(roomId, participantId) {
    if (preferred.backend === "WASAPI Exclusive") {
      await reconfigureAudio({ ...preferred, backend: "WASAPI Shared" });
    }
    await ensureSession();
    await bridge().joinRoomVoice(roomId, participantId);
    activeVoiceSession = { roomId, participantId };
  },

  async leaveVoiceSession() {
    await bridge().leaveRoomVoice();
    activeVoiceSession = null;
    remoteParticipantGains.clear();
    if (preferred.backend === "WASAPI Exclusive") {
      try {
        await reconfigureAudio(preferred);
        await ensureSession();
      } catch {
        await reconfigureAudio({ ...preferred, backend: "WASAPI Shared" }).catch(() => undefined);
        await ensureSession().catch(() => undefined);
      }
    }
  },

  async addRemoteParticipant(participantId) {
    await command("AddRemoteParticipant", { participantId });
    if (!remoteParticipantGains.has(participantId)) remoteParticipantGains.set(participantId, 1);
  },

  async removeRemoteParticipant(participantId) {
    await command("RemoveRemoteParticipant", { participantId });
    remoteParticipantGains.delete(participantId);
  },

  async setPlaybackRate(rate) {
    await command("SetPlaybackRate", { value: rate });
  },

  async setPitchShift(semitones) {
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

  async loadRadio(url) {
    await ensureSession();
    await command("LoadRadioStation", { url });
    await waitForRadioReady();
  },

  async playRadio() {
    await command("PlayRadio");
  },

  async pauseRadio() {
    await command("PauseRadio");
  },

  async stopRadio() {
    await command("StopRadio");
  },

  async setRadioGain(gain) {
    await command("SetRadioGain", { value: gain });
  },

  async playRecording(recordingId) {
    await ensureSession();
    const response = await bridge().pythonRequest({
      method: "GET",
      path: `/recordings/${encodeURIComponent(recordingId)}`,
    });
    if (!response.ok || !response.body || typeof response.body !== "object")
      throw new Error("Recording not found");
    const filePath = (response.body as Record<string, unknown>).filePath;
    if (typeof filePath !== "string")
      throw new Error("Recording file path is invalid");
    if (previewRecordingId !== recordingId || (await previewValues()).PreviewState === finishedStateNumber) {
      await command("LoadRecordingPreview", { path: filePath });
      await waitForPreviewReady();
      previewRecordingId = recordingId;
    }
    await command("PlayRecordingPreview");
    return snapshot("playing");
  },

  async pauseRecordingPreview() {
    await command("PauseRecordingPreview");
  },

  async seekRecordingPreview(positionSeconds) {
    const runtime = await this.runtimeConfiguration();
    await command("SeekRecordingPreview", { frame: Math.max(0, Math.round(positionSeconds * runtime.sampleRate)) });
  },

  async stopRecordingPreview() {
    await command("StopRecordingPreview");
  },

  async setPreviewVolume(gain) {
    await command("SetGain", { target: "preview", value: gain });
  },

  async recordingPreviewStatus() {
    const values = await previewValues();
    const sampleRate = Number(values.RuntimeOutputSampleRate || values.RequestedSampleRate || 48000) || 48000;
    const stateNumber = Number(values.PreviewState ?? readyStateNumber);
    return {
      recordingId: previewRecordingId,
      state: previewStates[stateNumber] ?? "ready",
      positionSeconds: (Number(values.PreviewPositionFrames || 0) || 0) / sampleRate,
    };
  },
};

export const getAudioSnapshot = (): Promise<PlaybackSnapshot> => snapshot();
