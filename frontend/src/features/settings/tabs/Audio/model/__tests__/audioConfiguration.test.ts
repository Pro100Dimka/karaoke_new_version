import { describe, expect, it } from "vitest";
import type { RequestedAudioConfiguration } from "../../../../../../contracts/models";
import {
  changeAudioValue,
  displayedAudioValues,
  toAudioRequest,
  toAudioValues,
} from "../audioConfiguration";

const request: RequestedAudioConfiguration = {
  backend: "WASAPI Shared",
  inputDeviceId: "mic-1",
  outputDeviceId: "out-1",
  sampleRate: 48000,
  periodFrames: 480,
  bufferFrames: 256,
};

describe("audio configuration transformations", () => {
  it("round-trips a request with explicit devices", () => {
    expect(toAudioRequest(toAudioValues(request))).toEqual(request);
  });

  it("round-trips a manually selected capture period", () => {
    const withCapturePeriod = { ...request, inputPeriodFrames: 128 };
    expect(toAudioRequest(toAudioValues(withCapturePeriod))).toEqual(
      withCapturePeriod,
    );
  });

  it("normalizes system-default device IDs without saving empty strings", () => {
    const values = toAudioValues({
      ...request,
      inputDeviceId: undefined,
      outputDeviceId: undefined,
    });
    expect(values.inputDeviceId).toBe("");
    expect(toAudioRequest(values).inputDeviceId).toBeUndefined();
    expect(toAudioRequest(values).outputDeviceId).toBeUndefined();
  });

  it("resets device timing and keeps both ASIO channels on the selected driver", () => {
    const values = toAudioValues({
      ...request,
      backend: "ASIO",
      inputPeriodFrames: 128,
    });
    expect(changeAudioValue(values, "inputDeviceId", "new")).toMatchObject({
      inputDeviceId: "new",
      outputDeviceId: "new",
      sampleRate: 0,
      periodFrames: 0,
      bufferFrames: 0,
      inputPeriodFrames: 0,
    });
    expect(values.inputDeviceId).toBe("mic-1");
  });

  it("derives negotiated timing without changing an automatic request", () => {
    const automatic = { ...request, sampleRate: 0, periodFrames: 0 };
    const shown = displayedAudioValues(
      automatic,
      {
        backend: "WASAPI Shared",
        sampleRate: 48000,
        periodFrames: 480,
        endpointBufferFrames: 960,
        estimatedLatencyMs: 20,
      },
      true,
    );
    expect(shown).toMatchObject({ sampleRate: 48000, periodFrames: 480 });
    expect(automatic.sampleRate).toBe(0);
    expect(automatic.periodFrames).toBe(0);
  });
});
