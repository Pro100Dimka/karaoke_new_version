import type { AudioBackendName, RequestedAudioConfiguration } from "../../contracts/models";

/** Form representation of the apply-required audio settings: "" stands for "system default" in the selects. */
export interface AudioValues {
  backend: AudioBackendName;
  sampleRate: number;
  periodFrames: number;
  inputDeviceId: string;
  outputDeviceId: string;
}

export const toAudioValues = (request: RequestedAudioConfiguration): AudioValues => ({
  backend: request.backend,
  sampleRate: request.sampleRate,
  periodFrames: request.periodFrames,
  inputDeviceId: request.inputDeviceId ?? "",
  outputDeviceId: request.outputDeviceId ?? ""
});

export const toAudioRequest = (values: AudioValues): RequestedAudioConfiguration => ({
  backend: values.backend,
  sampleRate: values.sampleRate,
  periodFrames: values.periodFrames,
  inputDeviceId: values.inputDeviceId || undefined,
  outputDeviceId: values.outputDeviceId || undefined
});
