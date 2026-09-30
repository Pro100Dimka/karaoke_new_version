import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAcousticLatencyAutoSave } from "./useAcousticLatencyAutoSave";

const mocks = vi.hoisted(() => ({
  passive: vi.fn(), setLatency: vi.fn(async () => undefined),
  updatePreferences: vi.fn(),
  stored: {} as Record<string, number>,
}));
vi.mock("../services/audioClient", () => ({ audioClient: { passiveAcousticLatency: mocks.passive, setAcousticLatency: mocks.setLatency } }));
vi.mock("./AppContext", () => ({
  useApp: () => ({
    preferences: {
      audio: { backend: "WASAPI Exclusive", inputDeviceId: "mic", outputDeviceId: "out", periodFrames: 0, sampleRate: 0 },
      acousticLatencyMs: mocks.stored,
    },
    updatePreferences: mocks.updatePreferences,
  }),
}));

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

it("saves the delay AudioService found from the song for the current device setup", async () => {
  mocks.passive.mockResolvedValue({ milliseconds: 34.62, backend: "WASAPI Exclusive", context: "session-a" });
  await check();
  expect(mocks.updatePreferences).toHaveBeenCalledWith({ acousticLatencyMs: { "WASAPI Exclusive|mic|out": 34.6 } });
});

it("preserves measurements saved for other audio setups", async () => {
  mocks.stored = { "WASAPI Shared|other-mic|other-output": 25 };
  mocks.passive.mockResolvedValue({ milliseconds: 34.62, backend: "WASAPI Exclusive", context: "session-a" });
  await check();
  expect(mocks.updatePreferences).toHaveBeenCalledWith({ acousticLatencyMs: {
    "WASAPI Shared|other-mic|other-output": 25,
    "WASAPI Exclusive|mic|out": 34.6,
  } });
});

it("keeps the stored delay when the new one differs by less than the estimate's agreement", async () => {
  mocks.stored = { "WASAPI Exclusive|mic|out": 34.2 };
  mocks.passive.mockResolvedValue({ milliseconds: 34.62, backend: "WASAPI Exclusive", context: "session-a" });
  await check();
  expect(mocks.updatePreferences).not.toHaveBeenCalled();
});

it("ignores an estimate found in a mode other than the chosen one", async () => {
  mocks.passive.mockResolvedValue({ milliseconds: 44, backend: "WASAPI Shared" });
  await check();
  expect(mocks.updatePreferences).not.toHaveBeenCalled();
});
