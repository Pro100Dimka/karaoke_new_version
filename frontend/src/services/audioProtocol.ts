import type {
  AudioBackendName,
  AudioConfigurationCapabilities,
  DeviceDto,
  RuntimeAudioConfiguration,
} from "../contracts/models";
import type { RemoteVoiceTiming, RoomTimingReport } from "../contracts/clients";

export const parseKeyValues = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split(/[;\n]/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator =
          line.indexOf(":") >= 0 ? line.indexOf(":") : line.indexOf("=");
        return separator < 0
          ? [line, ""]
          : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
  );

export const backendCode = (backend: AudioBackendName): string =>
  backend === "ASIO"
    ? "asio"
    : backend === "WASAPI Exclusive"
      ? "wasapi-exclusive"
      : "wasapi-shared";

export const backendName = (value: string): AudioBackendName =>
  value === "ASIO"
    ? "ASIO"
    : value === "WASAPI Exclusive"
      ? "WASAPI Exclusive"
      : "WASAPI Shared";

export const runtimeConfigurationFromDiagnostics = (
  values: Record<string, string>,
): RuntimeAudioConfiguration => {
  const sampleRate = Number(values.RuntimeOutputSampleRate || 0) || 0;
  const latencyFrames = Number(
    values.MonitoringLatencyFrames ?? values.EstimatedLatencyFrames,
  );
  const estimatedLatencyMs = (latencyFrames * 1000) / sampleRate;
  const calibratedLatencyMs = Number(values.AcousticLatencyUs) / 1000;
  return {
    backend: backendName(values.Backend ?? "WASAPI Shared"),
    sampleRate,
    calibrationContext: values.AcousticCalibrationContext,
    calibratedLatencyMs:
      values.AcousticCalibrationValid === "1" &&
      Number.isFinite(calibratedLatencyMs) &&
      calibratedLatencyMs >= 0 &&
      calibratedLatencyMs <= 500
        ? calibratedLatencyMs
        : undefined,
    periodFrames: Number(values.RuntimeOutputPeriodFrames || 0) || 0,
    endpointBufferFrames:
      Number(values.RuntimeOutputEndpointBufferFrames || 0) || 0,
    estimatedLatencyMs:
      Number.isFinite(sampleRate) &&
      sampleRate > 0 &&
      Number.isFinite(estimatedLatencyMs) &&
      estimatedLatencyMs > 0
        ? estimatedLatencyMs
        : null,
  };
};

const numberList = (value: string | undefined): number[] =>
  (value ?? "")
    .split(",")
    .map(Number)
    .filter((item) => Number.isFinite(item) && item > 0);

/** The formats a driver offers for an endpoint pair, always including its own defaults. */
export const audioCapabilitiesFromValues = (
  values: Record<string, string>,
): AudioConfigurationCapabilities => {
  const defaultSampleRate = Number(values.defaultSampleRateHz) || 0;
  const defaultPeriodFrames = Number(values.defaultPeriodFrames) || 0;
  const sampleRates = numberList(values.sampleRatesHz);
  let periodFrames = numberList(values.periodFrames);
  if (periodFrames.length === 0) {
    const minimum = Number(values.minPeriodFrames) || defaultPeriodFrames;
    const maximum = Number(values.maxPeriodFrames) || defaultPeriodFrames;
    const step = Math.max(1, Number(values.fundamentalPeriodFrames) || 1);
    // Keep the select responsive even when a driver exposes a frame-by-frame interval.
    if (minimum > 0 && maximum >= minimum && (maximum - minimum) / step <= 256)
      periodFrames = Array.from(
        { length: Math.floor((maximum - minimum) / step) + 1 },
        (_, index) => minimum + index * step,
      );
  }
  if (defaultSampleRate > 0 && !sampleRates.includes(defaultSampleRate))
    sampleRates.push(defaultSampleRate);
  if (defaultPeriodFrames > 0 && !periodFrames.includes(defaultPeriodFrames))
    periodFrames.push(defaultPeriodFrames);
  return {
    sampleRates: sampleRates.sort((left, right) => left - right),
    periodFrames: periodFrames.sort((left, right) => left - right),
    defaultSampleRate,
    defaultPeriodFrames,
  };
};

export interface RawDevice extends DeviceDto {
  backendIndex: number;
}

const deviceBackend = {
  2: "WASAPI Exclusive",
  3: "ASIO",
} as const satisfies Partial<Record<number, AudioBackendName>>;

export const parseDevices = (raw: string): RawDevice[] =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [
        id = "",
        name = "",
        backend = "1",
        direction = "0",
        channels = "0",
      ] = line.split(",");
      return {
        id,
        name,
        backendIndex: Number(backend) || 1,
        backend:
          deviceBackend[Number(backend) as keyof typeof deviceBackend] ??
          "WASAPI Shared",
        kind: direction === "1" ? ("output" as const) : ("input" as const),
        channels: Number(channels) || 0,
      };
    });

export const roomTimingFromDiagnostics = (
  values: Readonly<Record<string, string>>,
): RoomTimingReport => {
  const sampleRate =
    Number(values.RuntimeOutputSampleRate || values.RequestedSampleRate || 0) ||
    0;
  const roundTripMs = Math.max(0, Number(values.NetworkRoundTripMs || 0) || 0);
  const milliseconds = (frames: number): number =>
    sampleRate > 0 ? (frames * 1000) / sampleRate : 0;
  const deviceLatencyMs = Math.max(
    0,
    milliseconds(Number(values.EstimatedLatencyFrames || 0) || 0),
  );
  const remotes: Record<string, RemoteVoiceTiming> = {};
  const count = (name: string): number =>
    Math.max(0, Number(values[name] || 0) || 0);
  for (const [name, raw] of Object.entries(values)) {
    if (!name.startsWith("RemoteJitterMs.")) continue;
    const id = name.slice("RemoteJitterMs.".length);
    const targetFrames =
      Number(values[`RemoteTargetDelayFrames.${id}`] || 0) || 0;
    const excluded = values[`RemoteTimelineExcluded.${id}`];
    remotes[id] = {
      jitterMs: Math.max(0, Number(raw) || 0),
      targetDelayMs: Math.max(0, milliseconds(targetFrames)),
      relayPackets: count(`RemoteRelayFirstPackets.${id}`),
      directPackets: count(`RemoteDirectFirstPackets.${id}`),
      lateCuts: count(`RemoteLateAudioCuts.${id}`),
      ...(excluded === undefined ? {} : { excluded: Number(excluded) > 0 }),
    };
  }
  const requestedDelay =
    values.RoomRequestedDelayFrames === undefined
      ? {}
      : {
          requestedVoiceDelayMs: milliseconds(
            Number(values.RoomRequestedDelayFrames) || 0,
          ),
        };
  const returnRequirement =
    values.RoomReturnRequirementFrames === undefined
      ? {}
      : {
          returnRequirementMs: milliseconds(
            Number(values.RoomReturnRequirementFrames) || 0,
          ),
        };
  const arrivalRequirement =
    values.RoomArrivalRequirementFrames === undefined
      ? {}
      : {
          arrivalRequirementMs: milliseconds(
            Number(values.RoomArrivalRequirementFrames) || 0,
          ),
        };
  const roomPlayoutDelay =
    values.RoomPlayoutDelayFrames === undefined
      ? {}
      : {
          roomPlayoutDelayMs: milliseconds(
            Number(values.RoomPlayoutDelayFrames) || 0,
          ),
        };
  return {
    roundTripMs,
    deviceLatencyMs,
    packetsSent: count("NetworkPacketsSent"),
    packetsReceived: count("NetworkPacketsReceived"),
    relayEchoes: count("NetworkRelayEchoes"),
    networkTransportRunning: count("NetworkTransportRunning") > 0,
    networkSendEnabled: count("NetworkSendEnabled") > 0,
    remotes,
    ...requestedDelay,
    ...returnRequirement,
    ...arrivalRequirement,
    ...roomPlayoutDelay,
    voiceDelayMs: milliseconds(Number(values.RoomCompensationFrames || 0) || 0),
    followMs: 0,
    deviceStarvedFrames: count("RenderClockRebaseFrames"),
    // Start scheduling compensates only physical capture/route latency. Adaptive playout queues
    // are not added here because doing so used to feed a dynamic backing-track stretcher.
    estimatedVoiceLatencyMs: roundTripMs / 2 + deviceLatencyMs,
  };
};
