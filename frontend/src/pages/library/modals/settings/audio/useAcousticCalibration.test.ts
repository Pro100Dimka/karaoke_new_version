import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAudioConfiguration } from "../../../../../contracts/models";
import { useAcousticCalibration } from "./useAcousticCalibration";

type Measurement = { milliseconds: number; fingerprint?: string };
const calls = vi.hoisted(() => ({
  measure: vi.fn<() => Promise<Measurement>>(),
  preferences: { acousticLatencyMs: {} as Record<string, number> },
  updatePreferences: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("../../../../../services/audioClient", () => {
  const audio = { measureAcousticLatency: calls.measure };
  return { audioClient: audio };
});
vi.mock("../../../../../providers/application", () => ({
  useApp: () => ({
    preferences: calls.preferences,
    updatePreferences: calls.updatePreferences,
  }),
}));
vi.mock("../../../../../providers/notifications", () => ({
  useNotify: () => calls.notify,
}));


const runtime = (
  calibrationContext: string,
  calibratedLatencyMs?: number,
): RuntimeAudioConfiguration => ({
  backend: "WASAPI Shared",
  sampleRate: 48000,
  periodFrames: 480,
  endpointBufferFrames: 960,
  estimatedLatencyMs: 20,
  calibrationContext,
  calibratedLatencyMs,
});
const pendingMeasurement = () => {
  let resolve!: (measurement: Measurement) => void;
  const promise = new Promise<Measurement>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

describe("acoustic calibration lifecycle", () => {
  beforeEach(() => {
    calls.measure
      .mockReset()
      .mockResolvedValue({ milliseconds: 28.2, fingerprint: "device-a" });
    calls.preferences = { acousticLatencyMs: { existing: 12 } };
    calls.updatePreferences.mockReset();
    calls.notify.mockReset();
  });

  it("measures on request and saves the exact result for its device fingerprint", async () => {
    const { result } = renderHook(() =>
      useAcousticCalibration(true, runtime("a")),
    );
    expect(calls.measure).not.toHaveBeenCalled();
    await act(async () => result.current.measure());
    expect(calls.measure).toHaveBeenCalledOnce();
    expect(calls.updatePreferences).toHaveBeenCalledExactlyOnceWith({
      acousticLatencyMs: { existing: 12, "device-a": 28.2 },
    });
    expect(result.current.measuredHere).toBe(true);
    expect(result.current.measuring).toBe(false);
    expect(calls.notify).toHaveBeenCalledWith(expect.any(String), "success");
  });

  it("scopes a local measurement to its context and accepts an authoritative zero", async () => {
    const { result, rerender } = renderHook(
      ({ current, available }) => useAcousticCalibration(available, current),
      { initialProps: { current: runtime("a"), available: true } },
    );
    await act(async () => result.current.measure());
    expect(result.current.measured).toBeDefined();
    rerender({ current: runtime("b"), available: true });
    expect(result.current.measured).toBeUndefined();
    expect(result.current.measuredHere).toBe(false);
    rerender({ current: runtime("b", 0), available: true });
    expect(result.current.measured).toBe(0);
    rerender({ current: runtime("b", 0), available: false });
    expect(result.current.measured).toBeUndefined();
  });

  it.each(["context change", "unmount"] as const)(
    "ignores a measurement that completes after %s",
    async (change) => {
      const pending = pendingMeasurement();
      calls.measure.mockReturnValueOnce(pending.promise);
      const { result, rerender, unmount } = renderHook(
        ({ context }) => useAcousticCalibration(true, runtime(context)),
        { initialProps: { context: "a" } },
      );
      let operation!: Promise<void>;
      act(() => {
        operation = result.current.measure();
      });
      if (change === "unmount") unmount();
      else rerender({ context: "b" });
      await act(async () => {
        pending.resolve({ milliseconds: 28.2, fingerprint: "device-a" });
        await operation;
      });
      expect(calls.updatePreferences).not.toHaveBeenCalled();
      expect(calls.notify).not.toHaveBeenCalled();
    },
  );

  it("prevents overlapping measurements and merges into the latest saved preferences", async () => {
    const pending = pendingMeasurement();
    calls.measure.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(() =>
      useAcousticCalibration(true, runtime("a")),
    );
    let operation!: Promise<void>;
    act(() => {
      operation = result.current.measure();
      void result.current.measure();
    });
    expect(calls.measure).toHaveBeenCalledOnce();
    calls.preferences = { acousticLatencyMs: { existing: 12, newer: 17 } };
    rerender();
    await act(async () => {
      pending.resolve({ milliseconds: 28.2, fingerprint: "device-a" });
      await operation;
    });
    expect(calls.updatePreferences).toHaveBeenCalledExactlyOnceWith({
      acousticLatencyMs: { existing: 12, newer: 17, "device-a": 28.2 },
    });
  });

  it.each([
    ["AcousticMeasurementCancelled", "info"],
    ["Error", "error"],
  ] as const)(
    "handles %s without persisting a failed measurement",
    async (name, tone) => {
      const error = new Error("measurement stopped");
      error.name = name;
      calls.measure.mockRejectedValueOnce(error);
      const { result } = renderHook(() =>
        useAcousticCalibration(true, runtime("a")),
      );
      await act(async () => result.current.measure());
      expect(result.current.measuring).toBe(false);
      expect(calls.updatePreferences).not.toHaveBeenCalled();
      expect(calls.notify).toHaveBeenCalledWith(expect.any(String), tone);
    },
  );
});

vi.mock("../../../../../providers/store", () => ({ store: {
  get preferences() { return calls.preferences; },
  get updatePreferences() { return calls.updatePreferences; }
} }));
