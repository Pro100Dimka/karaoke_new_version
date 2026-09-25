import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackSnapshot } from "../../contracts/models";
import { usePositionPolling } from "./usePositionPolling";

const { getAudioSnapshot } = vi.hoisted(() => ({ getAudioSnapshot: vi.fn() }));
vi.mock("../../services/audioClient", () => ({ getAudioSnapshot }));

const snapshot = (positionSeconds: number, state: PlaybackSnapshot["state"] = "playing"): PlaybackSnapshot => ({
  sessionId: "s",
  state,
  positionSeconds,
  durationSeconds: 200,
  recording: false,
  monitoring: false,
  inputLevel: 0
});

describe("usePositionPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getAudioSnapshot.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps polling when room updates replace callbacks faster than the polling interval", async () => {
    getAudioSnapshot.mockResolvedValue(snapshot(12));
    const onPosition = vi.fn();
    const { rerender } = renderHook(({ onFinished }: { onFinished: () => void }) => usePositionPolling({
      enabled: true, isPollable: () => true, isPlaying: () => true,
      onPosition, onFinished, onLost: vi.fn(),
    }), { initialProps: { onFinished: vi.fn() } });
    for (let update = 0; update < 25; update++) {
      await vi.advanceTimersByTimeAsync(20);
      rerender({ onFinished: vi.fn() });
    }
    expect(getAudioSnapshot).toHaveBeenCalledTimes(5);
    expect(onPosition).toHaveBeenLastCalledWith(12);
  });

  it("keeps one request in flight while the audio service is slow and applies its reply", async () => {
    const deferred: Array<(value: PlaybackSnapshot) => void> = [];
    getAudioSnapshot.mockImplementation(
      () => new Promise<PlaybackSnapshot>(resolve => deferred.push(resolve))
    );
    const onPosition = vi.fn();

    renderHook(() =>
      usePositionPolling({
        enabled: true,
        isPollable: () => true,
        isPlaying: () => true,
        onPosition,
        onFinished: vi.fn(),
        onLost: vi.fn()
      })
    );

    await vi.advanceTimersByTimeAsync(3000);
    expect(deferred).toHaveLength(1);

    deferred[0]?.(snapshot(5));
    await Promise.resolve();
    expect(onPosition).toHaveBeenLastCalledWith(5);

    await vi.advanceTimersByTimeAsync(100);
    expect(deferred).toHaveLength(2);
    deferred[1]?.(snapshot(6));
    await Promise.resolve();
    expect(onPosition).toHaveBeenLastCalledWith(6);
  });

  it.each(["resolve", "reject"])("ignores a pending %s after polling is disabled", async outcome => {
    let settle = () => {};
    getAudioSnapshot.mockImplementation(() => new Promise<PlaybackSnapshot>((resolve, reject) => {
      settle = () => outcome === "resolve" ? resolve(snapshot(4, "finished")) : reject(new Error("lost"));
    }));
    const callbacks = { onPosition: vi.fn(), onSnapshot: vi.fn(), onFinished: vi.fn(), onLost: vi.fn() };
    const { rerender } = renderHook(({ enabled }) => usePositionPolling({
      enabled, isPollable: () => true, isPlaying: () => true, ...callbacks,
    }), { initialProps: { enabled: true } });
    await vi.advanceTimersByTimeAsync(100);
    rerender({ enabled: false });
    settle();
    await vi.advanceTimersByTimeAsync(0);
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it("still applies every reply when they resolve in the order they were sent", async () => {
    const deferred: Array<(value: PlaybackSnapshot) => void> = [];
    getAudioSnapshot.mockImplementation(
      () => new Promise<PlaybackSnapshot>(resolve => deferred.push(resolve))
    );
    const onPosition = vi.fn();

    renderHook(() =>
      usePositionPolling({
        enabled: true,
        isPollable: () => true,
        isPlaying: () => true,
        onPosition,
        onFinished: vi.fn(),
        onLost: vi.fn()
      })
    );

    await vi.advanceTimersByTimeAsync(100);
    deferred[0]?.(snapshot(1));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(100);
    deferred[1]?.(snapshot(2));
    await Promise.resolve();

    expect(onPosition.mock.calls.map(call => call[0])).toEqual([1, 2]);
  });

  it("invalidate() drops a poll's reply even if it was already in flight when called", async () => {
    // Mirrors a seek: a poll starts just before it, the seek invalidates around itself, and only then
    // does the pre-seek poll's reply land -- it must never be allowed to flash position backwards.
    const deferred: Array<(value: PlaybackSnapshot) => void> = [];
    getAudioSnapshot.mockImplementation(
      () => new Promise<PlaybackSnapshot>(resolve => deferred.push(resolve))
    );
    const onPosition = vi.fn();

    const { result } = renderHook(() =>
      usePositionPolling({
        enabled: true,
        isPollable: () => true,
        isPlaying: () => true,
        onPosition,
        onFinished: vi.fn(),
        onLost: vi.fn()
      })
    );

    await vi.advanceTimersByTimeAsync(100);
    expect(deferred).toHaveLength(1);

    result.current.invalidate();
    deferred[0]?.(snapshot(1));
    await Promise.resolve();
    expect(onPosition).not.toHaveBeenCalled();

    // A poll issued after invalidate() still applies normally.
    await vi.advanceTimersByTimeAsync(100);
    deferred[1]?.(snapshot(9));
    await Promise.resolve();
    expect(onPosition).toHaveBeenCalledWith(9);
  });

  it("forwards the authoritative live pitch from the same audio snapshot", async () => {
    getAudioSnapshot.mockResolvedValue({ ...snapshot(3), pitchHz: 440 });
    const onSnapshot = vi.fn();

    renderHook(() => usePositionPolling({
      enabled: true,
      isPollable: () => true,
      isPlaying: () => true,
      onPosition: vi.fn(),
      onSnapshot,
      onFinished: vi.fn(),
      onLost: vi.fn()
    }));

    await vi.advanceTimersByTimeAsync(100);
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ pitchHz: 440 }));
  });
});
