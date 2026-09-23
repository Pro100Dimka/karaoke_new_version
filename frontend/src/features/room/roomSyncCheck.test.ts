import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calibrationDelayMilliseconds,
  calibrationOffsetsMilliseconds,
  scheduleCalibrationClicks
} from "./roomSyncCheck";

afterEach(() => vi.useRealTimers());

describe("room synchronization click calibration", () => {
  it("compensates half of the room snapshot round trip when scheduling the shared start", () => {
    expect(calibrationDelayMilliseconds(
      "2026-09-23T16:00:03.000Z",
      "2026-09-23T16:00:00.000Z",
      40
    )).toBe(2980);
  });

  it("uses four evenly spaced audible reference clicks", () => {
    expect(calibrationOffsetsMilliseconds).toEqual([0, 500, 1000, 1500]);
  });

  it("plays every reference click through the native audio output", async () => {
    vi.useFakeTimers();
    const playClick = vi.fn(async () => undefined);
    scheduleCalibrationClicks(1000, playClick);

    await vi.advanceTimersByTimeAsync(2499);
    expect(playClick).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(playClick).toHaveBeenCalledTimes(4);
  });
});
