import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAcousticLatencyAutoSave } from "./useAcousticLatencyAutoSave";

const mocks = vi.hoisted(() => ({
  passive: vi.fn(),
  remember: vi.fn(async () => false),
  setLatency: vi.fn(async () => undefined),
  updatePreferences: vi.fn(),
  stored: {} as Record<string, number>,
}));
vi.mock("../services/audioClient", () => ({
  audioClient: {
    passiveAcousticLatency: mocks.passive,
    rememberAcousticLatencies: mocks.remember,
    setAcousticLatency: mocks.setLatency,
  },
}));
vi.mock("./AppContext", () => ({
  useApp: () => ({
    preferences: { acousticLatencyMs: mocks.stored },
    updatePreferences: mocks.updatePreferences,
  }),
}));

const path = "WASAPI Exclusive,{mic},{out},48000,48000,480,480,480,480";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.stored = {};
});

const check = async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => useAcousticLatencyAutoSave());
  await vi.advanceTimersByTimeAsync(5_000);
  hook.unmount();
};

it("hands the saved calibrations to AudioService as soon as the app starts, without a new measurement", async () => {
  mocks.stored = { [path]: 44.7 };
  mocks.passive.mockResolvedValue(null);
  vi.useFakeTimers();
  const hook = renderHook(() => useAcousticLatencyAutoSave());
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.remember).toHaveBeenCalledWith({ [path]: 44.7 });
  hook.unmount();
  expect(mocks.setLatency).not.toHaveBeenCalled();
});

it("saves the delay AudioService found from the song for the device path it was found on", async () => {
  mocks.passive.mockResolvedValue({
    milliseconds: 34.62,
    backend: "WASAPI Exclusive",
    context: "session-a",
    fingerprint: path,
  });
  await check();
  expect(mocks.updatePreferences).toHaveBeenCalledWith({
    acousticLatencyMs: { [path]: 34.6 },
  });
});

it("preserves measurements saved for other device paths", async () => {
  const other = "WASAPI Shared,{other-mic},{other-out},48000,48000,480,480,1056,1056";
  mocks.stored = { [other]: 25 };
  mocks.passive.mockResolvedValue({
    milliseconds: 34.62,
    backend: "WASAPI Exclusive",
    context: "session-a",
    fingerprint: path,
  });
  await check();
  expect(mocks.updatePreferences).toHaveBeenCalledWith({
    acousticLatencyMs: { [other]: 25, [path]: 34.6 },
  });
});

it("keeps the stored delay when the new one differs by less than the estimate's agreement", async () => {
  mocks.stored = { [path]: 34.2 };
  mocks.passive.mockResolvedValue({
    milliseconds: 34.62,
    backend: "WASAPI Exclusive",
    context: "session-a",
    fingerprint: path,
  });
  await check();
  expect(mocks.updatePreferences).not.toHaveBeenCalled();
});

it("saves nothing for an estimate whose device path is unknown", async () => {
  mocks.passive.mockResolvedValue({
    milliseconds: 44,
    backend: "WASAPI Shared",
    context: "session-a",
    fingerprint: "",
  });
  await check();
  expect(mocks.updatePreferences).not.toHaveBeenCalled();
});
