import { describe, expect, it } from "vitest";
import { audioCapabilitiesFromValues, parseKeyValues, runtimeConfigurationFromDiagnostics } from "./audioProtocol";

describe("device format capabilities", () => {
  it("lists the sample rates and buffers the selected device offers", () => {
    expect(audioCapabilitiesFromValues(parseKeyValues(
      "sampleRatesHz=44100,48000\nperiodFrames=128,256,512\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=256"
    ))).toEqual({ sampleRates: [44100, 48000], periodFrames: [128, 256, 512], defaultSampleRate: 44100, defaultPeriodFrames: 256 });
  });

  it("preserves ASIO buffer sizes and the default reported by the driver", () => {
    expect(audioCapabilitiesFromValues(parseKeyValues(
      "sampleRatesHz=44100\nperiodFrames=8,16,32,64,128\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=8"
    ))).toMatchObject({ periodFrames: [8, 16, 32, 64, 128], defaultPeriodFrames: 8 });
  });

  it("expands a driver's period interval and always offers its default", () => {
    expect(audioCapabilitiesFromValues({ minPeriodFrames: "64", maxPeriodFrames: "256", fundamentalPeriodFrames: "64", defaultPeriodFrames: "96" }))
      .toMatchObject({ periodFrames: [64, 96, 128, 192, 256] });
  });
});

describe("runtime acoustic calibration", () => {
  it.each(["NaN", "Infinity", "-1", "500001"])("rejects invalid latency %s", value => {
    expect(runtimeConfigurationFromDiagnostics({ AcousticCalibrationValid: "1",
      AcousticLatencyUs: value }).calibratedLatencyMs).toBeUndefined();
  });

  it("requires native validity and preserves a verified zero", () => {
    expect(runtimeConfigurationFromDiagnostics({ AcousticCalibrationValid: "0",
      AcousticLatencyUs: "23000" }).calibratedLatencyMs).toBeUndefined();
    expect(runtimeConfigurationFromDiagnostics({ AcousticCalibrationValid: "1",
      AcousticLatencyUs: "0" }).calibratedLatencyMs).toBe(0);
  });
});
