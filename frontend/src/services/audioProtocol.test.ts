import { describe, expect, it } from "vitest";
import {
  audioCapabilitiesFromValues,
  parseKeyValues,
  runtimeConfigurationFromDiagnostics,
} from "./audioProtocol";

describe("device format capabilities", () => {
  it("lists the sample rates and buffers the selected device offers", () => {
    expect(
      audioCapabilitiesFromValues(
        parseKeyValues(
          "sampleRatesHz=44100,48000\nperiodFrames=128,256,512\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=256",
        ),
      ),
    ).toEqual({
      sampleRates: [44100, 48000],
      periodFrames: [128, 256, 512],
      defaultSampleRate: 44100,
      defaultPeriodFrames: 256,
    });
  });

  it("preserves ASIO buffer sizes and the default reported by the driver", () => {
    expect(
      audioCapabilitiesFromValues(
        parseKeyValues(
          "sampleRatesHz=44100\nperiodFrames=8,16,32,64,128\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=8",
        ),
      ),
    ).toMatchObject({
      periodFrames: [8, 16, 32, 64, 128],
      defaultPeriodFrames: 8,
    });
  });

  it("preserves the endpoint's period availability reason", () => {
    expect(audioCapabilitiesFromValues({
      sampleRatesHz: "48000", periodFrames: "480", defaultSampleRateHz: "48000",
      defaultPeriodFrames: "480", periodSelectionReason: "IAUDIOCLIENT3_UNAVAILABLE",
    })).toMatchObject({ periodFrames: [480], periodSelectionReason: "IAUDIOCLIENT3_UNAVAILABLE" });
  });

  it("expands capture periods using that endpoint's own rate and fundamental", () => {
    expect(audioCapabilitiesFromValues({
      sampleRatesHz: "48000", periodFrames: "480", defaultSampleRateHz: "48000",
      defaultPeriodFrames: "480", inputSampleRateHz: "44100",
      inputMinPeriodFrames: "128", inputMaxPeriodFrames: "192",
      inputFundamentalPeriodFrames: "32", inputDefaultPeriodFrames: "192",
    })).toMatchObject({ inputPeriodFrames: [128, 160, 192], inputSampleRate: 44100 });
  });

  it("expands a driver's period interval and always offers its default", () => {
    expect(
      audioCapabilitiesFromValues({
        minPeriodFrames: "64",
        maxPeriodFrames: "256",
        fundamentalPeriodFrames: "64",
        defaultPeriodFrames: "96",
      }),
    ).toMatchObject({ periodFrames: [64, 96, 128, 192, 256] });
  });
});

describe("runtime acoustic calibration", () => {
  it("preserves selected, backend requested, and actual period separately", () => {
    expect(
      runtimeConfigurationFromDiagnostics({
        SelectedPeriodFrames: "128",
        RequestedPeriodFrames: "480",
        RuntimeOutputPeriodFrames: "480",
        PeriodSelectionFallback: "UNSUPPORTED_BY_CAPABILITIES",
      }),
    ).toMatchObject({
      selectedPeriodFrames: 128,
      requestedPeriodFrames: 480,
      periodFrames: 480,
      periodSelectionFallback: "UNSUPPORTED_BY_CAPABILITIES",
    });
  });
  it("preserves independently selected and actual capture periods", () => {
    expect(runtimeConfigurationFromDiagnostics({
      SelectedInputPeriodFrames: "128", RequestedInputPeriodFrames: "128",
      RuntimeInputPeriodFrames: "128",
    })).toMatchObject({ selectedInputPeriodFrames: 128,
      requestedInputPeriodFrames: 128, inputPeriodFrames: 128 });
  });
  it("preserves a Windows periodicity lock even when the user request was supported", () => {
    expect(runtimeConfigurationFromDiagnostics({
      SelectedPeriodFrames: "128", RequestedPeriodFrames: "128",
      RuntimeOutputPeriodFrames: "480", SharedEnginePeriodicityLocked: "1",
      SharedEnginePeriodFallback: "ENGINE_PERIODICITY_LOCKED",
    })).toMatchObject({
      selectedPeriodFrames: 128, requestedPeriodFrames: 128,
      periodFrames: 480, sharedPeriodLocked: true,
      sharedPeriodFallback: "ENGINE_PERIODICITY_LOCKED",
    });
  });
  it.each(["NaN", "Infinity", "-1", "500001"])(
    "rejects invalid latency %s",
    (value) => {
      expect(
        runtimeConfigurationFromDiagnostics({
          AcousticCalibrationValid: "1",
          AcousticLatencyUs: value,
        }).calibratedLatencyMs,
      ).toBeUndefined();
    },
  );

  it("requires native validity and preserves a verified zero", () => {
    expect(
      runtimeConfigurationFromDiagnostics({
        AcousticCalibrationValid: "0",
        AcousticLatencyUs: "23000",
      }).calibratedLatencyMs,
    ).toBeUndefined();
    expect(
      runtimeConfigurationFromDiagnostics({
        AcousticCalibrationValid: "1",
        AcousticLatencyUs: "0",
      }).calibratedLatencyMs,
    ).toBe(0);
  });
});
