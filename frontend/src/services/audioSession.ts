import { desktopBridge } from "./desktopBridge";
import { acceptClockSample, refreshNativeClock, type NativeClockSample } from "./nativeClock";
import type {
  DeviceDto,
  PlaybackSnapshot,
  RequestedAudioConfiguration,
} from "../contracts/models";
import {
  backendCode,
  backendName,
  diagnosticNumber,
  parseDevices,
  parseKeyValues,
  type RawDevice,
} from "./audioProtocol";
import { AudioReconfigurationState } from "./audioReconfiguration";

export const command = async (
  name: string,
  args?: AudioBridgeRequest["args"],
): Promise<string> => {
  const response = await desktopBridge().audioRequest({ command: name, args });
  if (response.status !== 0) throw new Error(response.text || `AudioService command failed: ${name}`);
  return response.text;
};

/** Windows' default endpoints in Shared mode: what a missing or failed device falls back to. */
export const defaultConfiguration: RequestedAudioConfiguration = {
  backend: "WASAPI Shared",
  sampleRate: 0,
  periodFrames: 0,
};

/**
 * What this app asked AudioService for, and what a restarted AudioService must be given again:
 * it remembers none of it across a restart or a reconfiguration.
 */
export const audioState = {
  /** The user's choice of mode and devices. */
  preferred: defaultConfiguration,
  /** The configuration AudioService actually runs, which may be the default after a failure. */
  active: defaultConfiguration,
  dspParameters: new Map<string, number>(),
  dspEnabled: false,
  // The singer's own mute (the room's microphone button); it never changes the microphone's volume.
  microphoneEnabled: true,
  monitoring: false,
  recording: false,
  durationSeconds: 0,
  sessionId: crypto.randomUUID(),
  reconfiguration: new AudioReconfigurationState(),
};

/** The device/format arguments every endpoint command shares; channel counts of 0 let AudioService choose. */
export const endpointArgs = (
  value: RequestedAudioConfiguration,
  inChannels = 0,
  outChannels = 0,
): AudioBridgeRequest["args"] => {
  const shared = value.backend === "WASAPI Shared";
  return {
    backend: backendCode(value.backend),
    input: value.inputDeviceId,
    output: value.outputDeviceId,
    rate: value.sampleRate,
    period: shared ? value.periodFrames : (value.bufferFrames ?? value.periodFrames),
    ...(shared && value.inputPeriodFrames && { inputPeriod: value.inputPeriodFrames }),
    inChannels,
    outChannels,
  };
};

export const rawDevices = async (): Promise<RawDevice[]> =>
  parseDevices(await command("GetDevices"));

/** The configured endpoint, when Windows still offers it for that mode (with channels, except ASIO). */
const findEndpoint = (
  devices: readonly RawDevice[],
  configuration: RequestedAudioConfiguration,
  kind: DeviceDto["kind"],
): RawDevice | undefined => {
  const id = kind === "input" ? configuration.inputDeviceId : configuration.outputDeviceId;
  if (!id) return undefined;
  return devices.find(
    (device) =>
      device.id === id &&
      device.kind === kind &&
      device.backend === configuration.backend &&
      (device.backend === "ASIO" || device.channels > 0),
  );
};

/** Whether every endpoint the configuration names is available (an unnamed one always is). */
export const endpointsAvailable = (
  devices: readonly RawDevice[],
  configuration: RequestedAudioConfiguration,
): boolean =>
  (!configuration.inputDeviceId || findEndpoint(devices, configuration, "input") !== undefined) &&
  (!configuration.outputDeviceId || findEndpoint(devices, configuration, "output") !== undefined);

let nativeClock: NativeClockSample | undefined;

/** AudioService's clock offset to this window's performance clock, once measured. */
export const audioClock = (): NativeClockSample | undefined => nativeClock;

export const refreshClock = async (): Promise<void> => {
  nativeClock = await refreshNativeClock(nativeClock, () => command("GetClock"));
};

export const diagnostics = async (): Promise<Record<string, string>> => {
  const started = performance.now();
  const values = parseKeyValues(await command("GetDiagnostics"));
  const received = performance.now();
  nativeClock = acceptClockSample(nativeClock, Number(values.MonotonicTicks), started, received);
  return values;
};

const sampleRateOf = (values: Record<string, string>): number =>
  diagnosticNumber(values.RuntimeOutputSampleRate || values.RequestedSampleRate);

export const currentSampleRate = async (): Promise<number> => sampleRateOf(await diagnostics());

const playbackStates: Readonly<Partial<Record<number, PlaybackSnapshot["state"]>>> = {
  3: "playing",
  4: "paused",
  6: "finished",
};

export const snapshot = async (
  forcedState?: PlaybackSnapshot["state"],
): Promise<PlaybackSnapshot> => {
  const values = await diagnostics();
  const sampleRate = sampleRateOf(values);
  const frames = diagnosticNumber(
    values.PlaybackPresentationPositionFrames ?? values.PlaybackPositionFrames,
  );
  audioState.monitoring = values.MonitoringEnabled === undefined
    ? audioState.monitoring
    : values.MonitoringEnabled === "1";
  return {
    sessionId: audioState.sessionId,
    state: forcedState ?? playbackStates[Number(values.PlaybackState ?? 2)] ?? "ready",
    positionSeconds: sampleRate > 0 ? frames / sampleRate : 0,
    durationSeconds: audioState.durationSeconds,
    recording: audioState.recording,
    monitoring: audioState.monitoring,
    monitoringSafetyTripped: values.MonitoringSafetyTripped === "1",
    inputLevel: diagnosticNumber(values.InputRMS),
    pitchHz: diagnosticNumber(values.InputPitchHz) || undefined,
  };
};

/** Ready, playing or paused: a song is loaded. */
const loadedPlaybackStates = new Set([2, 3, 4]);
const failedPlaybackState = 7;

export const waitForReady = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = Number((await diagnostics()).PlaybackState ?? 0);
    if (loadedPlaybackStates.has(state)) return;
    if (state === failedPlaybackState) throw new Error("AudioService failed to load the song");
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
  throw new Error("AudioService song loading timed out");
};

/** Opens the configuration's endpoints; a failing ASIO driver falls back to the default endpoints. */
const openEndpoints = async (
  configuration: RequestedAudioConfiguration,
  devices: readonly RawDevice[],
): Promise<RequestedAudioConfiguration> => {
  const input = findEndpoint(devices, configuration, "input");
  const output = findEndpoint(devices, configuration, "output");
  try {
    await command("PrepareSession", endpointArgs(configuration, input?.channels ?? 0, output?.channels ?? 0));
    await command("StartSession");
    return configuration;
  } catch (error) {
    if (configuration.backend !== "ASIO") throw error;
    await command("StopSession");
    await command("PrepareSession", endpointArgs(defaultConfiguration));
    await command("StartSession");
    return defaultConfiguration;
  }
};

/** A restarted AudioService knows none of the volumes and voice effects set before; they are
 * replayed so the new session sounds exactly like the knobs show. */
const replaySessionSettings = async (): Promise<void> => {
  for (const [target, value] of audioState.reconfiguration.mixerGains)
    await command("SetGain", { target, value });
  for (const [name, value] of audioState.dspParameters)
    await command("SetDspParameter", { name, value });
  if (audioState.dspEnabled) await command("SetDspEnabled", { enabled: true });
  if (!audioState.microphoneEnabled) await command("SetMicrophoneEnabled", { enabled: false });
};

const startSession = async (): Promise<void> => {
  const values = await diagnostics();
  const state = values.SessionState;
  if (state === "Running") return;
  // A session prepared in another mode than the chosen one is prepared again, never started as is.
  const chosenMode =
    values.Backend === undefined || backendName(values.Backend) === audioState.preferred.backend;
  if (state === "Prepared" && chosenMode) {
    await command("StartSession");
    return;
  }
  // Preparing is only allowed from Idle, so a failed or half-open session is closed first.
  if (state !== "Idle") await command("StopSession");
  const devices = await rawDevices();
  // Device ids are machine-specific. A copied profile or a disconnected interface must not disable
  // radio, monitoring and every other audio feature; recover through Windows' default endpoints.
  const configuration = endpointsAvailable(devices, audioState.preferred)
    ? audioState.preferred
    : defaultConfiguration;
  audioState.active = await openEndpoints(configuration, devices);
  await replaySessionSettings();
};

let sessionStart: Promise<void> | null = null;

/** Concurrent callers share one start-up so two PrepareSession commands can never race each other. */
export const ensureSession = (): Promise<void> => {
  sessionStart ??= startSession().finally(() => {
    sessionStart = null;
  });
  return sessionStart;
};
