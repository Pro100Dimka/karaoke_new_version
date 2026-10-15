import type {
  AudioBackendName,
  AudioConfigurationCapabilities,
  DeviceDto,
  LatencyParts,
  RuntimeAudioConfiguration,
} from "../contracts/models";
import type { RemoteVoiceTiming, RoomRequirementSource, RoomTimingReport } from "../contracts/clients";

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
  const raw = values.AcousticLatencyUs;
  const milliseconds = raw === undefined || raw.trim() === "" ? NaN : Number(raw) / 1000;
  const valid =
    values.AcousticCalibrationValid === "1" &&
    Number.isFinite(milliseconds) &&
    milliseconds >= 0 &&
    milliseconds <= 500;
  return valid ? milliseconds : undefined;
};

const finiteOrNull = (...texts: (string | undefined)[]): number | null => {
  if (texts.some((text) => text === undefined || text.trim() === "")) return null;
  const numbers = texts.map(Number);
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const sum = numbers.reduce((total, value) => total + value, 0);
  return Number.isFinite(sum) ? sum : null;
};

const latencyParts = (values: Record<string, string>): LatencyParts => {
  // -1 means the API was not asked or failed; 0 is the driver's own (uninformative) answer.
  const reported = Number(values.ReportedInputLatencyHns);
  return {
    inputMs: finiteOrNull(values.LocalCaptureDeviceMs),
    inputReportedMs: Number.isFinite(reported) && reported >= 0 ? reported / 10_000 : null,
    outputMs: finiteOrNull(values.LocalRenderQueueMs, values.LocalEndpointOutputMs),
    appMs: finiteOrNull(values.LocalAudioServiceInternalMs, values.LocalResamplerDspMs),
    bridgeMs: finiteOrNull(values.LocalAudioServiceInternalMs),
    dspMs: finiteOrNull(values.LocalResamplerDspMs),
  };
};

const estimatedLatency = (values: Record<string, string>, sampleRate: number): number | null => {
  const frames = Number(values.MonitoringLatencyFrames ?? values.EstimatedLatencyFrames);
  const milliseconds = (frames * 1000) / sampleRate;
  return sampleRate > 0 && Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
};

export const runtimeConfigurationFromDiagnostics = (
  values: Record<string, string>,
): RuntimeAudioConfiguration => {
  if (values.SessionState === "Failed")
    throw new Error(values.LastFailureMessage || "Audio session failed");
  const sampleRate = diagnosticNumber(values.RuntimeOutputSampleRate);
  // A timestamp difference already contains queue residence and elapsed processing. The model
  // is an alternative fallback, not another term, and acoustic corrections stay separate.
  const observed = finiteOrNull(values.LocalObservedMonitoringMs);
  const model = estimatedLatency(values, sampleRate);
  const available = values.LocalCaptureEstimateSource !== "NO_CAPTURE" && sampleRate > 0;
  // Right after streams open no full microphone block has reached render yet: that is "still
  // measuring", and the driver model must not stand in for the path being measured.
  const measuring = values.LocalObservedLatencyState === "MEASURING";
  const latency = available && !measuring ? observed ?? model : null;
  const elapsedP95Ms = (metric: string) => {
    if (values[`${metric}Samples`] !== undefined && !(Number(values[`${metric}Samples`]) > 0))
      return null;
    const value = finiteOrNull(values[`${metric}P95Us`]);
    return value === null ? null : value / 1000;
  };
  return {
    backend: backendName(values.Backend ?? "WASAPI Shared"),
    lowLatencyInputActive: values.LowLatencyMicrophoneActive === "1",
    lowLatencyInputFallback: values.LowLatencyMicrophoneFallback ?? "NONE",
    sampleRate,
    calibrationContext: values.AcousticCalibrationContext,
    calibratedLatencyMs: calibratedLatency(values),
    calibrationOrigin: (["PROFILE", "TEST_SIGNAL", "SONG"] as const).find(
      (origin) => origin === values.AcousticCalibrationOrigin,
    ) ?? "NONE",
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
    estimatedLatencyMs: latency,
    latencyEstimateSource: available && measuring ? "measuring" : latency === null ? "unavailable"
      : observed !== null ? "device-timeline" : "driver-model",
    captureTimestampAdjusted: values.LocalCaptureTimestampAdjusted === "1",
    latencyParts: latencyParts(values),
    latencyTiming: {
      renderCallbackP95Ms: elapsedP95Ms("RenderCallback"),
      captureCallbackP95Ms: elapsedP95Ms("CaptureCallback"),
      jitWaitP95Ms: elapsedP95Ms("RenderJitWaitOnly"),
      deadlineOvershootP95Ms: elapsedP95Ms("RenderJitDeadlineOvershoot"),
    },
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
const roomRequirements: readonly (readonly [string, RoomRequirementField, boolean])[] = [
  ["RoomRequestedDelayFrames", "requestedVoiceDelayMs", true],
  ["RoomReturnRequirementFrames", "returnRequirementMs", true],
  ["RoomArrivalRequirementFrames", "arrivalRequirementMs", false],
  ["RoomPlayoutDelayFrames", "roomPlayoutDelayMs", false],
];
const roomRequirementSources: readonly RoomRequirementSource[] = [
  "UNKNOWN", "BOOTSTRAP", "SHORT_WINDOW", "STABLE_HISTORY",
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
  const requirementSource = roomRequirementSources.find(source => source === values.RoomRequirementSource);
  const unknownDirect = values.RoomVoiceRoute === "direct" && requirementSource === "UNKNOWN";

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
  const outputLead = values.RoomVoiceRoute === "direct"
    ? Math.max(count("OutputDriverLatencyFrames"), count("RuntimeOutputLatencyFrames")) +
      count("RuntimeOutputPeriodFrames")
    : count("OutputDriverLatencyFrames");
  // Native route measurements end at socket receipt. The mix must arrive before submission of
  // the output buffer, not merely before its presentation. Only delivery requirements need this
  // lead; the relay ingress measurement and the server's fixed deadline keep their meanings.
  for (const [key, field, reserveOutputLead] of roomRequirements) {
    if (count("RemoteMuted.__room_server_mix__") > 0 &&
      (field === "returnRequirementMs" || field === "arrivalRequirementMs")) continue;
    if (values[key] !== undefined) {
      requirements[field] = unknownDirect && field === "requestedVoiceDelayMs"
        ? 0
        : milliseconds(count(key) + (reserveOutputLead ? outputLead : 0));
    }
  }

  return {
    roundTripMs,
    ...(["checking", "direct", "relay"].includes(values.RoomVoiceRoute ?? "") &&
      { voiceRoute: values.RoomVoiceRoute as "checking" | "direct" | "relay" }),
    generationId: values.generationId === undefined ? undefined : count("generationId"),
    deviceLatencyMs,
    packetsSent: count("NetworkPacketsSent"),
    packetsReceived: count("NetworkPacketsReceived"),
    relayEchoes: count("NetworkRelayEchoes"),
    networkTransportRunning: count("NetworkTransportRunning") > 0,
    networkSendEnabled: count("NetworkSendEnabled") > 0,
    remotes,
    ...requirements,
    ...(requirementSource !== undefined && { requirementSource }),
    voiceDelayMs: milliseconds(diagnosticNumber(values.RoomCompensationFrames)),
    followMs: 0,
    deviceStarvedFrames: count("RenderClockRebaseFrames"),
    // Start scheduling compensates only physical capture/route latency. Adaptive playout queues
    // are not added here because doing so used to feed a dynamic backing-track stretcher.
    estimatedVoiceLatencyMs: roundTripMs / 2 + deviceLatencyMs,
  };
};
