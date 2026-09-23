import { describe, expect, it } from "vitest";
import type { RequestedAudioConfiguration } from "../../contracts/models";
import { toAudioRequest, toAudioValues } from "./settingsModel";

const request: RequestedAudioConfiguration = {
  backend: "WASAPI Shared",
  inputDeviceId: "mic-1",
  outputDeviceId: "out-1",
  sampleRate: 48000,
  periodFrames: 480,
  bufferFrames: 256
};

describe("audio settings form values", () => {
  it("round-trips a request with explicit devices", () => {
    expect(toAudioRequest(toAudioValues(request))).toEqual(request);
  });

  it("shows unset devices as the empty system-default option and reads them back as unset", () => {
    const values = toAudioValues({ ...request, inputDeviceId: undefined, outputDeviceId: undefined });
    expect(values.inputDeviceId).toBe("");
    expect(toAudioRequest(values).inputDeviceId).toBeUndefined();
    expect(toAudioRequest(values).outputDeviceId).toBeUndefined();
  });
});
