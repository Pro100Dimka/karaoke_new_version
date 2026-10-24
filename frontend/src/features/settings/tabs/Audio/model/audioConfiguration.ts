import type {
  RequestedAudioConfiguration,
  RuntimeAudioConfiguration,
} from "../../../../../contracts/models";

/**
 * Display values use "" for the Windows default endpoint.
 * lowLatencyInput (Windows only) opens the microphone exclusively for minimum
 * latency.
 */
export type AudioValues = Pick<
  RequestedAudioConfiguration,
  | "backend"
  | "sampleRate"
  | "periodFrames"
  | "inputPeriodFrames"
  | "lowLatencyInput"
> & {
  bufferFrames: number;
  inputDeviceId: string;
  outputDeviceId: string;
};

export type AudioCommit = <K extends keyof AudioValues>(
  name: K,
  value: AudioValues[K],
) => void;

export const automaticAudioTiming = {
  sampleRate: 0,
  periodFrames: 0,
  inputPeriodFrames: 0,
  bufferFrames: 0,
} as const;

/** Changing a device invalidates its timing; an ASIO pair always uses one driver. */
export const changeAudioValue = <K extends keyof AudioValues>(
  current: AudioValues,
  name: K,
  value: AudioValues[K],
): AudioValues => {
  const next = { ...current, [name]: value };
  if (name === "backend") {
    Object.assign(next, automaticAudioTiming);
    if ((current.backend === "ASIO") !== (value === "ASIO")) {
      next.inputDeviceId = "";
      next.outputDeviceId = "";
    }
  } else if (name === "inputDeviceId" || name === "outputDeviceId") {
    Object.assign(next, automaticAudioTiming);
    if (current.backend === "ASIO")
      next.inputDeviceId = next.outputDeviceId = String(value);
  }
  return next;
};

export const toAudioValues = (
  request: RequestedAudioConfiguration,
  active?: RuntimeAudioConfiguration,
): AudioValues => ({
  backend: request.backend,
  sampleRate: request.sampleRate,
  periodFrames: request.periodFrames,
  inputPeriodFrames: request.inputPeriodFrames ?? 0,
  bufferFrames: request.bufferFrames ?? request.periodFrames,
  inputDeviceId: active?.inputDeviceId ?? request.inputDeviceId ?? "",
  outputDeviceId: active?.outputDeviceId ?? request.outputDeviceId ?? "",
  lowLatencyInput: request.lowLatencyInput === true,
});

export const toAudioRequest = (
  values: AudioValues,
): RequestedAudioConfiguration => ({
  backend: values.backend,
  sampleRate: values.sampleRate,
  periodFrames: values.periodFrames,
  ...((values.inputPeriodFrames ?? 0) > 0 && {
    inputPeriodFrames: values.inputPeriodFrames,
  }),
  bufferFrames: values.bufferFrames,
  inputDeviceId: values.inputDeviceId || undefined,
  outputDeviceId: values.outputDeviceId || undefined,
  ...(values.backend === "WASAPI Shared" &&
    values.lowLatencyInput && { lowLatencyInput: true }),
});

/** Show active endpoints and negotiated timing without modifying the persisted request. */
export const displayedAudioValues = (
  request: RequestedAudioConfiguration,
  runtime: RuntimeAudioConfiguration,
  useRuntime: boolean,
): AudioValues => {
  const actual =
    useRuntime && (request.backend !== "ASIO" || runtime.backend === "ASIO");
  const values = toAudioValues(request, actual ? runtime : undefined);
  if (!actual) return values;
  values.backend = runtime.backend;
  if (runtime.sampleRate > 0) values.sampleRate = runtime.sampleRate;
  if (runtime.backend === "WASAPI Shared")
    values.periodFrames = runtime.selectedPeriodFrames || runtime.periodFrames;
  else values.bufferFrames = runtime.periodFrames;
  return values;
};
