import { describe, expect, it } from "vitest";
import { audioRows } from "./audioRows";

describe("audio settings rows", () => {
  it("does not offer a Shared runtime period as an ASIO buffer", () => {
    const rows = audioRows(
      ((key: string) => key) as never,
      { backend: "ASIO", sampleRate: 48000, periodFrames: 0, bufferFrames: 256,
        inputDeviceId: "audient", outputDeviceId: "audient" },
      { backend: "WASAPI Shared", sampleRate: 44100, periodFrames: 441,
        endpointBufferFrames: 882, estimatedLatencyMs: 20 },
      [], true, () => undefined,
      { sampleRates: [44100], periodFrames: [128, 160, 441],
        defaultSampleRate: 44100, defaultPeriodFrames: 441 },
    );
    const row = rows.find((candidate) => "tag" in candidate && candidate.tag === "bufferFrames") as
      { label: string; hint: string; options: readonly { value: number }[] };
    expect(row.label).toBe("audioBuffer");
    expect(row.options.map((option) => option.value)).toEqual([256]);
    expect(row.hint).not.toContain("441");
  });
  it("offers driver-reported ASIO buffers even while Shared is the active fallback", () => {
    const rows = audioRows(
      ((key: string) => key) as never,
      { backend: "ASIO", sampleRate: 44100, periodFrames: 0, bufferFrames: 0,
        inputDeviceId: "audient", outputDeviceId: "audient" },
      { backend: "WASAPI Shared", sampleRate: 44100, periodFrames: 441,
        endpointBufferFrames: 882, estimatedLatencyMs: 20 },
      [], true, () => undefined,
      { sampleRates: [44100, 48000], periodFrames: [64, 128, 256],
        defaultSampleRate: 44100, defaultPeriodFrames: 64 },
      false, () => undefined, "ASIO",
    );
    const row = rows.find((candidate) => "tag" in candidate && candidate.tag === "bufferFrames") as
      { options: readonly { value: number }[] };
    expect(row.options.map((option) => option.value)).toEqual([64, 128, 256]);
  });
  it("shows a single supported Shared period with its duration and availability reason", () => {
    const rows = audioRows(
      ((key: string, args?: { value?: number }) => args?.value === undefined ? key : `${key}:${args.value}`) as never,
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480, bufferFrames: 0,
        inputDeviceId: "", outputDeviceId: "" },
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480,
        endpointBufferFrames: 960, estimatedLatencyMs: 30 },
      [], true, () => undefined,
      { sampleRates: [48000], periodFrames: [480], defaultSampleRate: 48000,
        defaultPeriodFrames: 480 },
    );
    const row = rows.find((candidate) => "tag" in candidate && candidate.tag === "periodFrames") as
      { options: readonly { value: unknown; label: string }[]; hint: string };
    expect(row.options).toEqual([{ value: 480, label: "framesValue:480 — 10.00 ms" }]);
    expect(row.hint).toContain("audioPeriodOnlyOne");
  });

  it("recomputes period milliseconds from the selected endpoint's negotiated rate", () => {
    const optionsAt = (rate: number) => {
      const rows = audioRows(
        ((key: string, args?: { value?: number }) => args?.value === undefined ? key : `${key}:${args.value}`) as never,
        { backend: "WASAPI Shared", sampleRate: rate, periodFrames: 128, bufferFrames: 0,
          inputDeviceId: "", outputDeviceId: "" },
        { backend: "WASAPI Shared", sampleRate: rate, periodFrames: 128,
          endpointBufferFrames: 256, estimatedLatencyMs: 10 },
        [], true, () => undefined,
        { sampleRates: [rate], periodFrames: [128], defaultSampleRate: rate,
          defaultPeriodFrames: 128 },
      );
      return (rows.find((candidate) => "tag" in candidate && candidate.tag === "periodFrames") as
        { options: readonly { label: string }[] }).options[0]?.label;
    };
    expect(optionsAt(44100)).toContain("2.90 ms");
    expect(optionsAt(48000)).toContain("2.67 ms");
  });

  it("does not offer a stale runtime period from a different endpoint", () => {
    const rows = audioRows(
      ((key: string) => key) as never,
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 128, bufferFrames: 0,
        inputDeviceId: "", outputDeviceId: "B" },
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 128,
        endpointBufferFrames: 256, estimatedLatencyMs: 10 },
      [], true, () => undefined,
      { sampleRates: [48000], periodFrames: [480], defaultSampleRate: 48000,
        defaultPeriodFrames: 480 },
    );
    const row = rows.find((candidate) => "tag" in candidate && candidate.tag === "periodFrames") as
      { options: readonly { value: unknown }[] };
    expect(row.options.map((option) => option.value)).toEqual([480]);
  });
  it("explains why an endpoint cannot offer Client3 period selection", () => {
    const rows = audioRows(
      ((key: string) => key) as never,
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480,
        bufferFrames: 0, inputDeviceId: "", outputDeviceId: "" },
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480,
        endpointBufferFrames: 960, estimatedLatencyMs: 30 },
      [], true, () => undefined,
      { sampleRates: [48000], periodFrames: [480], defaultSampleRate: 48000,
        defaultPeriodFrames: 480, periodSelectionReason: "IAUDIOCLIENT3_UNAVAILABLE" },
    );
    const row = rows.find((candidate) => "tag" in candidate && candidate.tag === "periodFrames") as
      { hint: string; options: readonly unknown[] };
    expect(row.options).toHaveLength(1);
    expect(row.hint).toContain("audioPeriodClient3Unavailable");
  });

  it("offers capture periods independently when render is limited to 480", () => {
    const rows = audioRows(
      ((key: string, params?: { value?: number }) =>
        key === "framesValue" ? `${params?.value} frames` : key) as never,
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480,
        inputPeriodFrames: 128, bufferFrames: 0, inputDeviceId: "mic", outputDeviceId: "out" },
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480,
        inputPeriodFrames: 448, selectedInputPeriodFrames: 128,
        requestedInputPeriodFrames: 128, inputPeriodMismatchReason: "ENGINE_PERIODICITY_LOCKED",
        endpointBufferFrames: 1056, estimatedLatencyMs: 27 },
      [], true, () => undefined,
      { sampleRates: [48000], periodFrames: [480], inputPeriodFrames: [128, 160, 448],
        inputSampleRate: 44100, defaultSampleRate: 48000, defaultPeriodFrames: 480 },
    );
    const row = rows.find((candidate) => "tag" in candidate && candidate.tag === "inputPeriodFrames") as
      { options: readonly { value: number; label: string }[]; hint: string };
    expect(row.options.map((option) => option.value)).toEqual([0, 128, 160, 448]);
    expect(row.options[1]?.label).toContain("2.90 ms");
    expect(row.hint).toContain("128");
    expect(row.hint).toContain("ENGINE_PERIODICITY_LOCKED");
  });

  it("shows a negotiated period lock alongside selected, requested and actual values", () => {
    const rows = audioRows(
      ((key: string, params?: { value?: number }) =>
        key === "framesValue" ? `${params?.value} frames` : key) as never,
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 128, bufferFrames: 0,
        inputDeviceId: "", outputDeviceId: "" },
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480,
        selectedPeriodFrames: 128, requestedPeriodFrames: 128,
        periodSelectionFallback: "NONE", sharedPeriodLocked: true,
        sharedPeriodFallback: "ENGINE_PERIODICITY_LOCKED",
        endpointBufferFrames: 960, estimatedLatencyMs: 37 },
      [], true, () => undefined,
      { sampleRates: [48000], periodFrames: [128, 256, 480], defaultSampleRate: 48000,
        defaultPeriodFrames: 480 },
    );
    const row = rows.find((candidate) => "tag" in candidate && candidate.tag === "periodFrames") as
      { hint: string };
    expect(row.hint).toContain("ENGINE_PERIODICITY_LOCKED");
    expect(row.hint).toContain("audioPeriodSelected");
    expect(row.hint).toContain("audioPeriodRequested");
    expect(row.hint).toContain("audioPeriodActual");
    expect(row.hint).toContain("2.67 ms");
    expect(row.hint).toContain("10.00 ms");
    expect(row.hint).toContain("128");
    expect(row.hint).toContain("480");
  });
  it("explains when the selected Shared period fell back to a supported period", () => {
    const rows = audioRows(
      ((key: string) => key) as never,
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 128, bufferFrames: 128,
        inputDeviceId: "", outputDeviceId: "" },
      { backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480,
        endpointBufferFrames: 960, estimatedLatencyMs: 30,
        selectedPeriodFrames: 128, requestedPeriodFrames: 480,
        periodSelectionFallback: "UNSUPPORTED_BY_CAPABILITIES" },
      [], true, () => undefined,
      { sampleRates: [48000], periodFrames: [480], defaultSampleRate: 48000,
        defaultPeriodFrames: 480 },
    );
    const row = rows.find((candidate) => "tag" in candidate && candidate.tag === "periodFrames");
    expect(row && "hint" in row && row.hint).toContain("runtimePeriodFallbackUnsupported");
  });
  it("does not present a Shared period fallback for an unavailable ASIO runtime", () => {
    const rows = audioRows(
      ((key: string) => key) as never,
      { backend: "ASIO", sampleRate: 48000, periodFrames: 128, bufferFrames: 128,
        inputDeviceId: "", outputDeviceId: "" },
      { backend: "ASIO", sampleRate: 0, periodFrames: 0,
        endpointBufferFrames: 0, estimatedLatencyMs: null,
        selectedPeriodFrames: 128, requestedPeriodFrames: 0,
        periodSelectionFallback: "UNSUPPORTED_BY_CAPABILITIES" },
      [], true, () => undefined,
      { sampleRates: [], periodFrames: [], defaultSampleRate: 0,
        defaultPeriodFrames: 0 },
    );
    const row = rows.find((candidate) => "tag" in candidate && candidate.tag === "bufferFrames");
    expect(row && "hint" in row && row.hint).not.toContain("runtimePeriodFallbackUnsupported");
  });
  it("shows only sample rates and periods reported by the selected device", () => {
    const rows = audioRows(
      ((key: string) => key) as never,
      {
        backend: "WASAPI Shared",
        sampleRate: 0,
        periodFrames: 0,
        bufferFrames: 0,
        inputDeviceId: "",
        outputDeviceId: "",
      },
      {
        backend: "WASAPI Shared",
        sampleRate: 44100,
        periodFrames: 441,
        endpointBufferFrames: 882,
        estimatedLatencyMs: 10,
      },
      [],
      true,
      () => undefined,
      {
        sampleRates: [44100],
        periodFrames: [441, 882],
        defaultSampleRate: 44100,
        defaultPeriodFrames: 441,
      },
    );
    const select = (tag: string) =>
      rows.find((row) => "tag" in row && row.tag === tag) as unknown as {
        options?: readonly { value: unknown }[];
      };
    expect(select("sampleRate").options?.map((option) => option.value)).toEqual(
      [44100],
    );
    expect(
      select("periodFrames").options?.map((option) => option.value),
    ).toEqual([441, 882]);
    expect((select("periodFrames") as { label?: string }).label).toBe(
      "audioPeriod",
    );
    expect(rows.some((row) => "tag" in row && row.tag === "bufferFrames")).toBe(
      false,
    );
  });

  it("shows a buffer field for exclusive and ASIO backends", () => {
    for (const backend of ["WASAPI Exclusive", "ASIO"] as const) {
      const rows = audioRows(
        ((key: string) => key) as never,
        {
          backend,
          sampleRate: 48000,
          periodFrames: 441,
          bufferFrames: 256,
          inputDeviceId: "",
          outputDeviceId: "",
        },
        {
          backend,
          sampleRate: 48000,
          periodFrames: 256,
          endpointBufferFrames: 512,
          estimatedLatencyMs: 10,
        },
        [],
        true,
        () => undefined,
        {
          sampleRates: [48000],
          periodFrames: [128, 256],
          defaultSampleRate: 48000,
          defaultPeriodFrames: 256,
        },
      );
      const row = rows.find(
        (candidate) => "tag" in candidate && candidate.tag === "bufferFrames",
      ) as { label?: string };
      expect(row.label).toBe("audioBuffer");
      expect(
        rows.some(
          (candidate) => "tag" in candidate && candidate.tag === "periodFrames",
        ),
      ).toBe(false);
    }
  });

  it("limits ASIO buffers to standard powers of two while preserving the active value", () => {
    const rows = audioRows(
      ((key: string) => key) as never,
      {
        backend: "ASIO",
        sampleRate: 48000,
        periodFrames: 0,
        bufferFrames: 300,
        inputDeviceId: "",
        outputDeviceId: "",
      },
      {
        backend: "ASIO",
        sampleRate: 48000,
        periodFrames: 300,
        endpointBufferFrames: 300,
        estimatedLatencyMs: 10,
      },
      [],
      true,
      () => undefined,
      {
        sampleRates: [48000],
        periodFrames: Array.from({ length: 1024 }, (_, index) => index + 1),
        defaultSampleRate: 48000,
        defaultPeriodFrames: 512,
      },
    );
    const row = rows.find(
      (candidate) => "tag" in candidate && candidate.tag === "bufferFrames",
    ) as {
      options?: readonly { value: unknown }[];
    };
    expect(row.options?.map((option) => option.value)).toEqual([
      32, 64, 128, 256, 300, 512, 1024,
    ]);
  });
});
