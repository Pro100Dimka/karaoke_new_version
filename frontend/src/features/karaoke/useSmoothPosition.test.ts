import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSmoothPosition } from "./useSmoothPosition";

describe("useSmoothPosition", () => {
  let now = 0;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const frameAt = (milliseconds: number) => {
    now = milliseconds;
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((frame) => frame(now)));
  };

  beforeEach(() => {
    now = 0;
    nextFrame = 0;
    frames.clear();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not count a short pause as played audio on resume", () => {
    const { result, rerender } = renderHook(
      ({ playing }) => useSmoothPosition(10, playing, 1),
      { initialProps: { playing: false } },
    );
    now = 60;
    rerender({ playing: true });
    frameAt(76);
    expect(result.current).toBeCloseTo(10.016, 6);
  });

  it("applies a changed rate only to time after the change", () => {
    const { result, rerender } = renderHook(
      ({ rate }) => useSmoothPosition(10, true, rate),
      { initialProps: { rate: 1 } },
    );
    frameAt(30);
    rerender({ rate: 2 });
    frameAt(46);
    expect(result.current).toBeCloseTo(10.062, 6);
  });

  it.each([0.5, 0.75, 1, 1.25, 1.5, 2])(
    "advances source seconds once at playback rate %s",
    (rate) => {
      const { result } = renderHook(() => useSmoothPosition(10, true, rate));
      frameAt(100);
      expect(result.current).toBeCloseTo(10 + 0.1 * rate, 6);
    },
  );

  it("uses the current audio position after a render stall and seeks in both directions", () => {
    const { result, rerender } = renderHook(
      ({ seconds }) => useSmoothPosition(seconds, true, 1),
      { initialProps: { seconds: 0 } },
    );
    now = 1_800_000;
    rerender({ seconds: 1800 });
    frameAt(1_800_016);
    expect(result.current).toBeCloseTo(1800.016, 6);
    now = 1_800_020;
    rerender({ seconds: 2000 });
    frameAt(1_800_036);
    expect(result.current).toBeCloseTo(2000.016, 6);
    now = 1_800_040;
    rerender({ seconds: 3 });
    frameAt(1_800_056);
    expect(result.current).toBeCloseTo(3.016, 6);
  });
});
