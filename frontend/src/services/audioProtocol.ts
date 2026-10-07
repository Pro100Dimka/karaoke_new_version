import type {
  AudioBackendName,
  AudioConfigurationCapabilities,
  DeviceDto,
  RuntimeAudioConfiguration,
} from "../contracts/models";
import type { RemoteVoiceTiming, RoomTimingReport } from "../contracts/clients";

/** A diagnostic number; absent, empty or non-numeric text reads as 0. */
export const diagnosticNumber = (value: string | undefined): number => Number(value) || 0;

const keyValue = (line: string): [string, string] => {
  const colon = line.indexOf(":");
  const separator = colon >= 0 ? colon : line.indexOf("=");
  if (separator < 0) return [line, ""];
  return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
};

export const parseKeyValues = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split(/[;\n]/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(keyValue),
  );

const backendCodes = {
  ASIO: "asio",
  "WASAPI Exclusive": "wasapi-exclusive",
  "WASAPI Shared": "wasapi-shared",
} as const satisfies Record<AudioBackendName, string>;

export const backendCode = (backend: AudioBackendName): string => backendCodes[backend];

const isBackendName = (value: string): value is AudioBackendName =>
  Object.hasOwn(backendCodes, value);

export const backendName = (value: string): AudioBackendName =>
  isBackendName(value) ? value : "WASAPI Shared";

const calibratedLatency = (values: Record<string, string>): number | undefined => {
  const milliseconds = Number(values.AcousticLatencyUs) / 1000;
  const valid =
    values.AcousticCalibrationValid === "1" &&
    Number.isFinite(milliseconds) &&
    milliseconds >= 0 &&
    milliseconds <= 500;
  return valid ? milliseconds : undefined;
};

const estimatedLatency = (values: Record<string, string>, sampleRate: number): number | null => {
  const frames = Number(values.MonitoringLatencyFrames ?? values.EstimatedLatencyFrames);
  const milliseconds = (frames * 1000) / sampleRate;
  return sampleRate > 0 && Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
};

export const runtimeConfigurationFromDiagnostics = (
  values: Record<string, string>,
): RuntimeAudioConfiguration => {
  const sampleRate = diagnosticNumber(values.RuntimeOutputSampleRate);
  return {
    backend: backendName(values.Backend ?? "WASAPI Shared"),
    sampleRate,
    calibrationContext: values.AcousticCalibrationContext,
    calibratedLatencyMs: calibratedLatency(values),
    periodFrames: diagnosticNumber(values.RuntimeOutputPeriodFrames),
    ...(values.RuntimeInputPeriodFrames && {
      inputPeriodFrames: diagnosticNumber(values.RuntimeInputPeriodFrames),
    }),
    ...(values.SelectedInputPeriodFrames && {
      selectedInputPeriodFrames: diagnosticNumber(values.SelectedInputPeriodFrames),
    }),
    ...(values.RequestedInputPeriodFrames && {
      requestedInputPeriodFrames: diagnosticNumber(values.RequestedInputPeriodFrames),
    }),
    inputPeriodMismatchReason: values.InputPeriodMismatchReason,
    selectedPeriodFrames: diagnosticNumber(values.SelectedPeriodFrames),
    requestedPeriodFrames: diagnosticNumber(values.RequestedPeriodFrames),
    periodSelectionFallback: values.PeriodSelectionFallback,
    periodMismatchReason: values.PeriodMismatchReason,
    sharedPeriodFallback: values.SharedEnginePeriodFallback,
    sharedPeriodLocked: values.SharedEnginePeriodicityLocked === "1",
    endpointBufferFrames: diagnosticNumber(values.RuntimeOutputEndpointBufferFrames),
    estimatedLatencyMs: estimatedLatency(values, sampleRate),
  };
};

const numberList = (value: string | undefined): number[] =>
  (value ?? "")
    .split(",")
    .map(Number)
    .filter((item) => Number.isFinite(item) && item > 0);

const ascending = (left: number, right: number) => left - right;

interface PeriodRange {
  list: string | undefined;
  minimum: string | undefined;
  maximum: string | undefined;
  fundamental: string | undefined;
  defaultFrames: number;
}

/** The periods a driver accepts: its list, or its interval when it only reports one. */
const periodChoices = (range: PeriodRange, shared: boolean): number[] => {
  const minimum = diagnosticNumber(range.minimum);
  const maximum = diagnosticNumber(range.maximum);
  const step = Math.max(1, Number(range.fundamental) || 1);
  const first = shared ? Math.ceil(minimum / step) * step : minimum;
  let choices = numberList(range.list);
  // Keep the select responsive even when a driver exposes a frame-by-frame interval.
  if (choices.length === 0 && first > 0 && maximum >= first && (maximum - first) / step <= 256) {
    choices = Array.from(
      { length: Math.floor((maximum - first) / step) + 1 },
      (_, index) => first + index * step,
    );
  }
  const isValid = (frames: number) =>
    frames > 0 &&
    (!shared ||
      (frames % step === 0 &&
        (minimum === 0 || frames >= minimum) &&
        (maximum === 0 || frames <= maximum)));
  const valid = choices.filter(isValid);
  if (isValid(range.defaultFrames) && !valid.includes(range.defaultFrames)) {
    valid.push(range.defaultFrames);
  }
  return valid.sort(ascending);
};

/** The formats a driver offers for an endpoint pair, including valid defaults. */
export const audioCapabilitiesFromValues = (
  values: Record<string, string>,
  backend: AudioBackendName = "WASAPI Shared",
): AudioConfigurationCapabilities => {
  const shared = backend === "WASAPI Shared";
  const defaultSampleRate = diagnosticNumber(values.defaultSampleRateHz);
  const defaultPeriodFrames = diagnosticNumber(values.defaultPeriodFrames);
  const sampleRates = numberList(values.sampleRatesHz);
  if (defaultSampleRate > 0 && !sampleRates.includes(defaultSampleRate)) {
    sampleRates.push(defaultSampleRate);
  }
  const periodFrames = periodChoices(
    {
      list: values.periodFrames,
      minimum: values.minPeriodFrames,
      maximum: values.maxPeriodFrames,
      fundamental: values.fundamentalPeriodFrames,
      defaultFrames: defaultPeriodFrames,
    },
    shared,
  );
  const inputPeriodFrames = periodChoices(
    {
      list: values.inputPeriodFrames,
      minimum: values.inputMinPeriodFrames,
      maximum: values.inputMaxPeriodFrames,
      fundamental: values.inputFundamentalPeriodFrames,
      defaultFrames: diagnosticNumber(values.inputDefaultPeriodFrames),
    },
    shared,
  );
  return {
    sampleRates: sampleRates.sort(ascending),
    periodFrames,
    ...(inputPeriodFrames.length > 0 && {
      inputPeriodFrames,
      inputSampleRate: Number(values.inputSampleRateHz) || defaultSampleRate,
    }),
    defaultSampleRate,
    defaultPeriodFrames,
    periodSelectionReason: values.periodSelectionReason,
  };
};

export interface RawDevice extends DeviceDto {
  backendIndex: number;
}

const deviceBackends: Readonly<Partial<Record<number, AudioBackendName>>> = {
  2: "WASAPI Exclusive",
  3: "ASIO",
};

const parseDevice = (line: string): RawDevice => {
  const [id = "", name = "", backend = "1", direction = "0", channels = "0"] = line.split(",");
  return {
    id,
    name,
    backendIndex: Number(backend) || 1,
    backend: deviceBackends[Number(backend)] ?? "WASAPI Shared",
    kind: direction === "1" ? "output" : "input",
    channels: diagnosticNumber(channels),
  };
};

export const parseDevices = (raw: string): RawDevice[] =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseDevice);

type RoomRequirementField =
  | "requestedVoiceDelayMs"
  | "returnRequirementMs"
  | "arrivalRequirementMs"
  | "roomPlayoutDelayMs";

/** Room requirements a client reports only once it has measured them. */
const roomRequirements: readonly (readonly [string, RoomRequirementField])[] = [
  ["RoomRequestedDelayFrames", "requestedVoiceDelayMs"],
  ["RoomReturnRequirementFrames", "returnRequirementMs"],
  ["RoomArrivalRequirementFrames", "arrivalRequirementMs"],
  ["RoomPlayoutDelayFrames", "roomPlayoutDelayMs"],
];

export const roomTimingFromDiagnostics = (
  values: Readonly<Record<string, string>>,
): RoomTimingReport => {
  const sampleRate = diagnosticNumber(values.RuntimeOutputSampleRate || values.RequestedSampleRate);
  const milliseconds = (frames: number): number =>
    sampleRate > 0 ? (frames * 1000) / sampleRate : 0;
  const count = (name: string): number => Math.max(0, diagnosticNumber(values[name]));
  const roundTripMs = count("NetworkRoundTripMs");
  const deviceLatencyMs = Math.max(0, milliseconds(diagnosticNumber(values.EstimatedLatencyFrames)));

  const remotes: Record<string, RemoteVoiceTiming> = {};
  for (const [name, raw] of Object.entries(values)) {
    if (!name.startsWith("RemoteJitterMs.")) continue;
    const id = name.slice("RemoteJitterMs.".length);
    const excluded = values[`RemoteTimelineExcluded.${id}`];
    remotes[id] = {
      jitterMs: Math.max(0, diagnosticNumber(raw)),
      targetDelayMs: Math.max(0, milliseconds(diagnosticNumber(values[`RemoteTargetDelayFrames.${id}`]))),
      relayPackets: count(`RemoteRelayFirstPackets.${id}`),
      directPackets: count(`RemoteDirectFirstPackets.${id}`),
      lateCuts: count(`RemoteLateAudioCuts.${id}`),
      ...(excluded !== undefined && { excluded: Number(excluded) > 0 }),
    };
  }

  const requirements: Partial<Record<RoomRequirementField, number>> = {};
  for (const [key, field] of roomRequirements) {
    if (values[key] !== undefined) requirements[field] = milliseconds(diagnosticNumber(values[key]));
  }

  return {
    roundTripMs,
    deviceLatencyMs,
    packetsSent: count("NetworkPacketsSent"),
    packetsReceived: count("NetworkPacketsReceived"),
    relayEchoes: count("NetworkRelayEchoes"),
    networkTransportRunning: count("NetworkTransportRunning") > 0,
    networkSendEnabled: count("NetworkSendEnabled") > 0,
    remotes,
    ...requirements,
    voiceDelayMs: milliseconds(diagnosticNumber(values.RoomCompensationFrames)),
    followMs: 0,
    deviceStarvedFrames: count("RenderClockRebaseFrames"),
    // Start scheduling compensates only physical capture/route latency. Adaptive playout queues
    // are not added here because doing so used to feed a dynamic backing-track stretcher.
    estimatedVoiceLatencyMs: roundTripMs / 2 + deviceLatencyMs,
  };
};
