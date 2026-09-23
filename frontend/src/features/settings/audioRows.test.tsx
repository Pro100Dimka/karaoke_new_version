import { describe, expect, it } from "vitest";
import { audioRows } from "./audioRows";

describe("audio settings rows", () => {
  it("shows only sample rates and periods reported by the selected device", () => {
    const rows = audioRows(
      ((key: string) => key) as never,
      { backend: "WASAPI Shared", sampleRate: 0, periodFrames: 0, inputDeviceId: "", outputDeviceId: "" },
      { backend: "WASAPI Shared", sampleRate: 44100, periodFrames: 441, endpointBufferFrames: 882, estimatedLatencyMs: 10 },
      [],
      true,
      () => undefined,
      { sampleRates: [44100], periodFrames: [441, 882], defaultSampleRate: 44100, defaultPeriodFrames: 441 },
    );
    const select = (tag: string) => rows.find(row => "tag" in row && row.tag === tag) as unknown as {
      options?: readonly { value: unknown }[];
    };
    expect(select("sampleRate").options?.map(option => option.value)).toEqual([44100]);
    expect(select("periodFrames").options?.map(option => option.value)).toEqual([441, 882]);
    expect((select("periodFrames") as { label?: string }).label).toBe("audioPeriod");
  });

  it("shows a buffer field for exclusive and ASIO backends", () => {
    for (const backend of ["WASAPI Exclusive", "ASIO"] as const) {
      const rows = audioRows(
        ((key: string) => key) as never,
        { backend, sampleRate: 48000, periodFrames: 256, inputDeviceId: "", outputDeviceId: "" },
        { backend, sampleRate: 48000, periodFrames: 256, endpointBufferFrames: 512, estimatedLatencyMs: 10 },
        [], true, () => undefined,
        { sampleRates: [48000], periodFrames: [128, 256], defaultSampleRate: 48000, defaultPeriodFrames: 256 },
      );
      const row = rows.find(candidate => "tag" in candidate && candidate.tag === "periodFrames") as { label?: string };
      expect(row.label).toBe("audioBuffer");
    }
  });
});
