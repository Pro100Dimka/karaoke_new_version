import { desktopBridge } from "./desktopBridge";
import { measureAcousticLatency } from "./acousticLatency";
import {
  acceptClockSample,
  refreshNativeClock,
  type NativeClockSample,
} from "./nativeClock";
import type { AudioServiceClient } from "../contracts/clients";
import type {
  DeviceDto,
  PlaybackSnapshot,
  RequestedAudioConfiguration,
  SongDto,
} from "../contracts/models";
import {
  audioCapabilitiesFromValues,
  backendCode,
  backendName,
  parseDevices,
  parseKeyValues,
  roomTimingFromDiagnostics,
  runtimeConfigurationFromDiagnostics,
} from "./audioProtocol";
import { createAudioPlayers } from "./audioPlayers";
import { AudioReconfigurationState } from "./audioReconfiguration";
import { mixerGain } from "./mixerLevel";
import { roomServerMixParticipantId } from "../features/room/roomModel";

const command = async (
  name: string,
  args?: AudioBridgeRequest["args"],
): Promise<string> => {
  const response = await desktopBridge().audioRequest({ command: name, args });
  if (response.status !== 0)
    throw new Error(response.text || `AudioService command failed: ${name}`);
  return response.text;
};

let preferred: RequestedAudioConfiguration = {
  backend: "WASAPI Shared",
  sampleRate: 0,
  periodFrames: 0,
};
let activeConfiguration: RequestedAudioConfiguration = preferred;

/** The device/format arguments every endpoint command shares; channel counts of 0 let AudioService choose. */
const endpointArgs = (
  value: RequestedAudioConfiguration,
  inChannels = 0,
  outChannels = 0,
): AudioBridgeRequest["args"] => ({
  backend: backendCode(value.backend),
  input: value.inputDeviceId,
  output: value.outputDeviceId,
  rate: value.sampleRate,
  period:
    value.backend === "WASAPI Shared"
      ? value.periodFrames
      : (value.bufferFrames ?? value.periodFrames),
  inChannels,
  outChannels,
});

let durationSeconds = 0;
let monitoring = false;
// The singer's own mute (the room's microphone button); it never changes the microphone's volume.
let microphoneEnabled = true;
const mutedParticipants = new Set<string>();
let recording = false;
let sessionId = crypto.randomUUID();
const dspParameters = new Map<string, number>();
let dspEnabled = false;
let activeVoiceSession: {
  roomId: string;
  participantId: string;
  serverClockOffsetMilliseconds?: number;
} | null = null;
// One server-owned deadline for backing audio and every remote voice in the active room.
let roomPlayoutDelayMilliseconds = 0;
// The session in which a manual measurement was accepted; the server rejects stale contexts.
let calibrationContext = "";
const remoteParticipantGains = new Map<string, number>();
type RemoteEffect =
  "reverb" | "echo" | "delay" | "noiseSuppression" | "octave" | "autoTune";
const remoteParticipantEffects = new Map<string, Map<RemoteEffect, number>>();
const reconfiguration = new AudioReconfigurationState();
const reconfigureAudio = (
  value: RequestedAudioConfiguration,
): Promise<string> => command("Reconfigure", endpointArgs(value));
const rawDevices = async () => parseDevices(await command("GetDevices"));
const configurationEndpointsAvailable = async (
  configuration: RequestedAudioConfiguration,
): Promise<boolean> => {
  if (!configuration.inputDeviceId && !configuration.outputDeviceId)
    return true;
  const devices = await rawDevices();
  const available = (kind: DeviceDto["kind"], id: string | undefined) =>
    !id ||
    devices.some(
      (device) =>
        device.id === id &&
        device.kind === kind &&
        device.backend === configuration.backend &&
        device.channels > 0,
    );
  return (
    available("input", configuration.inputDeviceId) &&
    available("output", configuration.outputDeviceId)
  );
};
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
  const chosenMode =
    values.Backend === undefined ||
    backendName(values.Backend) === preferred.backend;
  if (state === "Prepared" && chosenMode)
    return void (await command("StartSession"));
  // Preparing is only allowed from Idle, so a failed or half-open session is closed first.
  if (state !== "Idle") await command("StopSession");
  const devices = await rawDevices();
  const find = (
    configuration: RequestedAudioConfiguration,
    kind: DeviceDto["kind"],
    id: string | undefined,
  ) => {
    if (!id) return undefined;
    return devices.find(
      (candidate) =>
        candidate.id === id &&
        candidate.kind === kind &&
        candidate.backend === configuration.backend &&
        candidate.channels > 0,
    );
  };
  const savedEndpointsAvailable =
    (!preferred.inputDeviceId ||
      find(preferred, "input", preferred.inputDeviceId) !== undefined) &&
    (!preferred.outputDeviceId ||
      find(preferred, "output", preferred.outputDeviceId) !== undefined);
  // Device ids are machine-specific. A copied profile or a disconnected interface must not disable
  // radio, monitoring and every other audio feature; recover through Windows' default endpoints.
  const configuration: RequestedAudioConfiguration = savedEndpointsAvailable
    ? preferred
    : { backend: "WASAPI Shared", sampleRate: 0, periodFrames: 0 };
  const input = find(configuration, "input", configuration.inputDeviceId);
  const output = find(configuration, "output", configuration.outputDeviceId);
  await command(
    "PrepareSession",
    endpointArgs(configuration, input?.channels || 0, output?.channels || 0),
  );
  await command("StartSession");
  activeConfiguration = configuration;
  // A restarted AudioService knows none of the volumes and voice effects set before; they are
  // replayed so the new session sounds exactly like the knobs show.
  for (const [target, value] of reconfiguration.mixerGains)
    await command("SetGain", { target, value });
  for (const [name, value] of dspParameters)
    await command("SetDspParameter", { name, value });
  if (dspEnabled) await command("SetDspEnabled", { enabled: true });
  if (!microphoneEnabled)
    await command("SetMicrophoneEnabled", { enabled: false });
};

let nativeClock: NativeClockSample | undefined;
const refreshClock = async (): Promise<void> => {
  nativeClock = await refreshNativeClock(nativeClock, () =>
    command("GetClock"),
  );
};
const diagnostics = async (): Promise<Record<string, string>> => {
  const started = performance.now();
  const values = parseKeyValues(await command("GetDiagnostics"));
  const received = performance.now();
  nativeClock = acceptClockSample(
    nativeClock,
    Number(values.MonotonicTicks),
    started,
    received,
  );
  return values;
};

const sampleRateOf = (values: Record<string, string>): number =>
  Number(values.RuntimeOutputSampleRate || values.RequestedSampleRate || 0) ||
  0;
const currentSampleRate = async (): Promise<number> =>
  sampleRateOf(await diagnostics());

const snapshot = async (
  forcedState?: PlaybackSnapshot["state"],
): Promise<PlaybackSnapshot> => {
  const values = await diagnostics();
  const sampleRate = sampleRateOf(values);
  const frames =
    Number(
      values.PlaybackPresentationPositionFrames ??
        values.PlaybackPositionFrames ??
        0,
    ) || 0;
  const stateNumber = Number(values.PlaybackState ?? 2);
  const states: Record<number, PlaybackSnapshot["state"]> = {
    3: "playing",
    4: "paused",
    6: "finished",
  };
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
  if (
    activeVoiceSession &&
    !remoteParticipantGains.has(roomServerMixParticipantId)
  )
    remoteParticipantGains.set(roomServerMixParticipantId, 1);
  for (const [participantId, gain] of remoteParticipantGains) {
    if (participantId !== roomServerMixParticipantId) {
      const setGain = desktopBridge().setRoomVoiceParticipantGain;
      if (!setGain) {
        remoteParticipantGains.delete(participantId);
        mutedParticipants.delete(participantId);
        continue;
      }
      try {
        await setGain(
          participantId,
          mutedParticipants.has(participantId) ? 0 : gain,
        );
      } catch {
        // A remembered person may belong to an old room. Their preference is local and must not
        // prevent the new room voice session from reconnecting.
        remoteParticipantGains.delete(participantId);
        mutedParticipants.delete(participantId);
      }
      continue;
    }
    await command("AddRemoteParticipant", { participantId });
    await command("SetRemoteGain", { participantId, value: gain });
    for (const [effect, value] of remoteParticipantEffects.get(participantId) ??
      [])
      await command("SetRemoteEffect", { participantId, effect, value });
    if (mutedParticipants.has(participantId))
      await command("SetRemoteMute", { participantId, muted: true });
  }
};
const restoreVoiceSession = async (): Promise<void> => {
  const voice = activeVoiceSession;
  if (!voice) return;
  await ensureSession();
  await synchronizeRoomClock(voice.serverClockOffsetMilliseconds, true);
  await desktopBridge().joinRoomVoice(voice.roomId, voice.participantId);
  await restoreRemoteParticipants();
  await command("SetRoomPlayoutDelay", {
    milliseconds: roomPlayoutDelayMilliseconds,
  });
};
const synchronizeRoomClock = async (
  offset?: number,
  force = false,
): Promise<void> => {
  if (offset === undefined || !Number.isFinite(offset)) return;
  if (!force && activeVoiceSession?.serverClockOffsetMilliseconds === offset)
    return;
  await diagnostics();
  await refreshClock();
  if (!nativeClock) throw new Error("AudioService clock is unavailable");
  const now = performance.now();
  await command("SetRoomClock", {
    serverMicros: Math.round((now + offset) * 1000),
    localMicros: Math.round((now + nativeClock.offset) * 1000),
  });
  if (activeVoiceSession)
    activeVoiceSession.serverClockOffsetMilliseconds = offset;
};
const restoreMediaSession = (
  checkpoint: Awaited<ReturnType<typeof reconfiguration.checkpoint>>,
) =>
  reconfiguration.restore(checkpoint, dspParameters, dspEnabled, monitoring, {
    ensureSession,
    resolveArtifacts: (song) =>
      desktopBridge().resolveProjectArtifacts(
        song.id,
        song.activeRevision || 0,
      ),
    command,
    waitForReady,
    sampleRate: currentSampleRate,
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
      microphone: devices.some(
        (device) => device.kind === "input" && device.channels > 0,
      )
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

  preferredConfiguration() {
    return { ...preferred };
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
    if (
      !(Number(values.AcousticPassiveAccepted) > 0) ||
      values.Backend === undefined
    )
      return null;
    if (
      values.AcousticCalibrationValid !== "1" ||
      !values.AcousticCalibrationContext
    )
      return null;
    return {
      milliseconds: Number(values.AcousticPassiveUs) / 1000,
      backend: backendName(values.Backend),
      context: values.AcousticCalibrationContext,
    };
  },

  async measureAcousticLatency() {
    await ensureSession();
    const measured = await measureAcousticLatency((name) => command(name));
    await command("SetAcousticLatency", {
      ms: measured.milliseconds,
      context: measured.context,
    });
    calibrationContext = measured.context;
    return measured.milliseconds;
  },

  async applyConfiguration(configuration) {
    // Reconfigure is destructive inside AudioService: it closes the active backend before opening
    // the replacement. Reject a device that Windows no longer enumerates before touching the
    // working session, so a temporary USB/driver disappearance cannot silence an active room.
    if (!(await configurationEndpointsAvailable(configuration)))
      throw new Error(`${configuration.backend} device is unavailable`);
    const previous = activeConfiguration;
    const checkpoint = await reconfiguration.checkpoint(snapshot);
    preferred = configuration;
    try {
      await reconfigureAudio(configuration);
      activeConfiguration = configuration;
      await ensureSession();
      await restoreVoiceSession();
      await restoreMediaSession(checkpoint);
      return await this.runtimeConfiguration();
    } catch (error) {
      preferred = previous;
      // Restore the previous complete audio graph before surfacing a rejected endpoint.
      await reconfigureAudio(previous);
      activeConfiguration = previous;
      await ensureSession();
      await restoreVoiceSession();
      await restoreMediaSession(checkpoint);
      throw error;
    }
  },

  async openBackendControlPanel(configuration) {
    await command("OpenBackendControlPanel", endpointArgs(configuration));
  },

  async configurationCapabilities(configuration) {
    return audioCapabilitiesFromValues(
      parseKeyValues(
        await command("GetAudioCapabilities", endpointArgs(configuration)),
      ),
    );
  },

  async spectrum() {
    const values = parseKeyValues(await command("GetSpectrum"));
    const parseBands = (value: string | undefined) =>
      (value ?? "").split(",").map(Number).filter(Number.isFinite);
    return {
      bands: parseBands(values.bands),
      backingBands: parseBands(values.backingBands),
    };
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
    const artifacts = await desktopBridge().resolveProjectArtifacts(
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
      if (
        !Number.isFinite(Number(values.MonotonicTicks)) ||
        !nativeClock ||
        !Number.isFinite(schedule.startAtMilliseconds) ||
        !(Number(values.RuntimeOutputSampleRate) > 0)
      )
        throw new Error("AudioService playback clock is unavailable");
      if (!Number.isFinite(schedule.positionSeconds))
        throw new Error("Invalid playback position");
      args = {
        startAtTicks: Math.max(
          0,
          Math.round((schedule.startAtMilliseconds + nativeClock.offset) * 1e6),
        ),
        frame: Math.max(
          0,
          Math.round(
            schedule.positionSeconds * Number(values.RuntimeOutputSampleRate),
          ),
        ),
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
    // A stopped song stays loaded otherwise, and its open files keep Windows from deleting or moving it.
    await command("UnloadSong");
    recording = false;
    reconfiguration.song = null;
    return snapshot("finished");
  },

  async setMonitoring(enabled) {
    if (enabled) {
      for (const [name, value] of dspParameters)
        await command("SetDspParameter", { name, value });
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
    const gain = muted ? 0 : (remoteParticipantGains.get(participantId) ?? 1);
    await desktopBridge().setRoomVoiceParticipantGain(participantId, gain);
    if (muted) mutedParticipants.add(participantId);
    else mutedParticipants.delete(participantId);
  },
  participantMuted: (participantId) => mutedParticipants.has(participantId),

  async setParticipantVolume(participantId, gain) {
    remoteParticipantGains.set(participantId, gain);
    await desktopBridge().setRoomVoiceParticipantGain(
      participantId,
      mutedParticipants.has(participantId) ? 0 : gain,
    );
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
    const effects =
      remoteParticipantEffects.get(participantId) ??
      new Map<RemoteEffect, number>();
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
    if (running !== undefined && backendName(running) !== preferred.backend) {
      const selected = preferred;
      await this.applyConfiguration(selected).catch(() => {
        // A temporary device failure may keep the room on its working fallback, but it must not
        // turn that fallback into the user's selection. A later join/recovery retries ASIO.
        preferred = selected;
      });
    }
    await synchronizeRoomClock(serverClockOffsetMilliseconds, true);
    await desktopBridge().joinRoomVoice(roomId, participantId);
    activeVoiceSession = {
      roomId,
      participantId,
      serverClockOffsetMilliseconds,
    };
    await restoreRemoteParticipants();
  },

  async reconnectVoiceSession() {
    await restoreVoiceSession();
  },

  async leaveVoiceSession() {
    await desktopBridge().leaveRoomVoice();
    activeVoiceSession = null;
    if (roomPlayoutDelayMilliseconds > 0)
      await command("SetRoomPlayoutDelay", { milliseconds: 0 });
    roomPlayoutDelayMilliseconds = 0;
    remoteParticipantGains.clear();
    remoteParticipantEffects.clear();
    mutedParticipants.clear();
  },

  async addRemoteParticipant(participantId) {
    await command("AddRemoteParticipant", { participantId });
    if (!remoteParticipantGains.has(participantId))
      remoteParticipantGains.set(participantId, 1);
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
    pythonRequest: (request) => desktopBridge().pythonRequest(request),
    sampleRate: currentSampleRate,
  }),
};

export const getAudioSnapshot = (): Promise<PlaybackSnapshot> => snapshot();

// The automated Electron room test must exercise this exact production lifecycle rather than
// reconstructing join/rejoin calls in Playwright. The hook is absent from ordinary app sessions.
if (window.desktop?.roomE2e)
  window.roomE2eReconnectVoiceSession = () =>
    audioClient.reconnectVoiceSession();
