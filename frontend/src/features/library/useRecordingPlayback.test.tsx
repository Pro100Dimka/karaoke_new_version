import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingPlayback } from "./useRecordingPlayback";

const audio = vi.hoisted(() => ({
  playRecording: vi.fn(), pauseRecordingPreview: vi.fn(), stopRecordingPreview: vi.fn(),
  seekRecordingPreview: vi.fn(), recordingPreviewStatus: vi.fn(),
}));
vi.mock("../../services/audioClient", () => ({ audioClient: audio }));
const recording = {
  id: "take", filePath: "take.wav", songId: "song", displayName: "Take",
  createdAt: "2026-09-25T00:00:00Z", durationSeconds: 60, analyzed: false,
};

describe("recording preview polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const method of Object.values(audio)) method.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("keeps one slow status request in flight", async () => {
    audio.recordingPreviewStatus.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useRecordingPlayback(recording));
    await act(() => result.current.toggle());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(audio.recordingPreviewStatus).toHaveBeenCalledOnce();
  });

  it("ignores a pending status reply after playback is paused", async () => {
    let resolve!: (value: unknown) => void;
    audio.recordingPreviewStatus.mockReturnValue(new Promise(value => { resolve = value; }));
    const { result } = renderHook(() => useRecordingPlayback(recording));
    await act(() => result.current.toggle());
    await act(() => vi.advanceTimersByTimeAsync(100));
    await act(() => result.current.toggle());
    await act(async () => { resolve({ recordingId: "take", state: "playing", positionSeconds: 17 }); });
    expect(result.current.position).toBe(0);
    expect(result.current.playing).toBe(false);
  });
});
