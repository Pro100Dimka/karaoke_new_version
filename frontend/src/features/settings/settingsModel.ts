import type { AudioBackendName, RequestedAudioConfiguration } from "../../contracts/models";

/** Form representation of audio settings. Device ids use "" for the Windows default endpoint. */
export interface AudioValues {
  backend: AudioBackendName;
  sampleRate: number;
  periodFrames: number;
  bufferFrames: number;
  inputDeviceId: string;
  outputDeviceId: string;
}

export const toAudioValues = (request: RequestedAudioConfiguration): AudioValues => ({
  backend: request.backend,
  sampleRate: request.sampleRate,
  periodFrames: request.periodFrames,
  bufferFrames: request.bufferFrames ?? request.periodFrames,
  inputDeviceId: request.inputDeviceId ?? "",
  outputDeviceId: request.outputDeviceId ?? ""
});

export const toAudioRequest = (values: AudioValues): RequestedAudioConfiguration => ({
  backend: values.backend,
  sampleRate: values.sampleRate,
  periodFrames: values.periodFrames,
  bufferFrames: values.bufferFrames,
  inputDeviceId: values.inputDeviceId || undefined,
  outputDeviceId: values.outputDeviceId || undefined
});
