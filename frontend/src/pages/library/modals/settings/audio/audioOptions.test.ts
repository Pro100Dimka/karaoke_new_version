import { describe, expect, it } from "vitest";
import type {
  AudioBackendName,
  AudioConfigurationCapabilities,
  RuntimeAudioConfiguration,
} from "../../../../../contracts/models";
import type { AudioValues } from "./audioConfiguration";
import { audioOptions } from "./audioOptions";

const choices = (
  overrides: {
    backend?: AudioBackendName;
    values?: Partial<AudioValues>;
    runtime?: Partial<RuntimeAudioConfiguration>;
    capabilities?: Partial<AudioConfigurationCapabilities>;
    capabilitiesBackend?: AudioBackendName;
  } = {},
) => {
  const backend = overrides.backend ?? "WASAPI Shared";
  return audioOptions({
    values: {
      backend,
      sampleRate: 48000,
      periodFrames: 128,
      bufferFrames: 128,
      inputDeviceId: "",
      outputDeviceId: "",
      ...overrides.values,
    },
    runtime: {
      backend,
      sampleRate: 48000,
      periodFrames: 128,
      endpointBufferFrames: 256,
      estimatedLatencyMs: 6,
      ...overrides.runtime,
    },
    configurationCapabilities: {
      sampleRates: [48000],
      periodFrames: [128, 256],
      defaultSampleRate: 48000,
      defaultPeriodFrames: 128,
      ...overrides.capabilities,
    },
    capabilitiesBackend: overrides.capabilitiesBackend,
  });
};
const values = (options: readonly { value: number }[]) =>
  options.map((option) => option.value);

describe("device-supported audio choices", () => {
  it("does not offer Shared runtime periods as ASIO buffers", () => {
    const result = choices({
      backend: "ASIO",
      values: { bufferFrames: 256 },
      runtime: {
        backend: "WASAPI Shared",
        sampleRate: 44100,
        periodFrames: 441,
      },
      capabilities: { sampleRates: [44100], periodFrames: [128, 160, 441] },
    });
    expect(values(result.periods)).toEqual([256]);
  });
  it("offers driver-reported ASIO buffers while Shared is the fallback", () => {
    const result = choices({
      backend: "ASIO",
      values: { bufferFrames: 0 },
      capabilitiesBackend: "ASIO",
      runtime: { backend: "WASAPI Shared", periodFrames: 441 },
      capabilities: { periodFrames: [64, 128, 256] },
    });
    expect(values(result.periods)).toEqual([64, 128, 256]);
  });
  it("returns the single period supported by the Shared endpoint", () => {
    const result = choices({
      values: { periodFrames: 480 },
      runtime: { periodFrames: 480 },
      capabilities: { periodFrames: [480] },
    });
    expect(values(result.periods)).toEqual([480]);
  });
  it("does not offer a stale Shared runtime period from a different endpoint", () => {
    expect(
      values(
        choices({
          values: { outputDeviceId: "B", periodFrames: 128 },
          runtime: { periodFrames: 128 },
          capabilities: { periodFrames: [480], defaultPeriodFrames: 480 },
        }).periods,
      ),
    ).toEqual([480]);
  });
  it("offers only the engine period without Client3 selection", () => {
    expect(
      choices({
        values: { periodFrames: 480 },
        runtime: { periodFrames: 480 },
        capabilities: {
          periodFrames: [480],
          periodSelectionReason: "IAUDIOCLIENT3_UNAVAILABLE",
        },
      }).periods,
    ).toHaveLength(1);
  });
  it("offers capture periods independently when render is limited to 480", () => {
    const result = choices({
      values: { periodFrames: 480, inputPeriodFrames: 128 },
      runtime: {
        periodFrames: 480,
        inputPeriodFrames: 448,
        selectedInputPeriodFrames: 128,
        requestedInputPeriodFrames: 128,
        inputPeriodMismatchReason: "ENGINE_PERIODICITY_LOCKED",
      },
      capabilities: {
        periodFrames: [480],
        inputPeriodFrames: [128, 160, 448],
        inputSampleRate: 44100,
      },
    });
    expect(values(result.inputPeriods)).toEqual([0, 128, 160, 448]);
  });
  it("shows only rates and Shared periods reported by the selected device", () => {
    const result = choices({
      values: { sampleRate: 0, periodFrames: 0, bufferFrames: 0 },
      runtime: { sampleRate: 44100, periodFrames: 441 },
      capabilities: {
        sampleRates: [44100],
        periodFrames: [441, 882],
        defaultSampleRate: 44100,
      },
    });
    expect(values(result.sampleRates)).toEqual([44100]);
    expect(values(result.periods)).toEqual([441, 882]);
  });
  it("limits ASIO buffers to standard powers of two while preserving the active value", () => {
    const result = choices({
      backend: "ASIO",
      values: { bufferFrames: 300 },
      runtime: { periodFrames: 300 },
      capabilities: {
        periodFrames: Array.from({ length: 1024 }, (_, index) => index + 1),
      },
    });
    expect(values(result.periods)).toEqual([32, 64, 128, 256, 300, 512, 1024]);
  });
});
