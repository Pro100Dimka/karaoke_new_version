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

  it("ignores an earlier poll's reply that resolves after a later, fresher one", async () => {
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
    await vi.advanceTimersByTimeAsync(100);
    expect(deferred).toHaveLength(2);

    // The second (later-issued) poll's round trip happens to finish first, with the fresher position.
    deferred[1]?.(snapshot(5));
    await Promise.resolve();
    expect(onPosition).toHaveBeenLastCalledWith(5);

    // The first (earlier-issued) poll's reply only lands afterwards, carrying a now-stale position.
    deferred[0]?.(snapshot(1));
    await Promise.resolve();
    expect(onPosition).not.toHaveBeenCalledWith(1);
    expect(onPosition).toHaveBeenLastCalledWith(5);
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
});
