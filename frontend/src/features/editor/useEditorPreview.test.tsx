import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient, getAudioSnapshot } from "../../services/audioClient";
import { useEditorPreview } from "./useEditorPreview";

vi.mock("../../services/audioClient", () => ({
  audioClient: { play: vi.fn(), pause: vi.fn(), seek: vi.fn() },
  getAudioSnapshot: vi.fn(),
}));

describe("editor preview lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(audioClient.play).mockResolvedValue({} as never);
    vi.mocked(audioClient.pause).mockResolvedValue({} as never);
    vi.mocked(audioClient.seek).mockResolvedValue({} as never);
    vi.mocked(getAudioSnapshot).mockResolvedValue({
      positionSeconds: 12.5,
      state: "playing",
    } as never);
  });
  afterEach(() => vi.useRealTimers());

  it("owns preview play, seek and authoritative position polling", async () => {
    const failed = vi.fn();
    const { result } = renderHook(() => useEditorPreview(true, failed));

    await act(() => result.current.togglePlay());
    expect(audioClient.play).toHaveBeenCalled();
    expect(result.current.playing).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.position).toBe(12.5);

    await act(() => result.current.seek(7));
    expect(audioClient.seek).toHaveBeenCalledWith(7);
    expect(result.current.position).toBe(7);
  });


  it("polls only during playback, never queues overlapping requests, and ignores a reply after pause", async () => {
    vi.useFakeTimers();
    vi.mocked(audioClient.play).mockResolvedValue({} as never);
    vi.mocked(audioClient.pause).mockResolvedValue({} as never);
    let resolve!: (value: { positionSeconds: number; state: string }) => void;
    vi.mocked(getAudioSnapshot).mockImplementation(() => new Promise(done => { resolve = done as typeof resolve; }));
    const { result, unmount } = renderHook(() => useEditorPreview(true, vi.fn()));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(getAudioSnapshot).not.toHaveBeenCalled();
    await act(async () => { await result.current.togglePlay(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(getAudioSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.togglePlay(); });
    await act(async () => { resolve({ positionSeconds: 8, state: "playing" }); });
    expect(result.current.position).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(getAudioSnapshot).toHaveBeenCalledTimes(1);
    unmount();
  });
});
