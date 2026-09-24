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
    vi.mocked(getAudioSnapshot).mockResolvedValue({ positionSeconds: 12.5, state: "playing" } as never);
  });
  afterEach(() => vi.useRealTimers());

  it("owns preview play, seek and authoritative position polling", async () => {
    const failed = vi.fn();
    const { result } = renderHook(() => useEditorPreview(true, failed));

    await act(() => result.current.togglePlay());
    expect(audioClient.play).toHaveBeenCalled();
    expect(result.current.playing).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(result.current.position).toBe(12.5);

    await act(() => result.current.seek(7));
    expect(audioClient.seek).toHaveBeenCalledWith(7);
    expect(result.current.position).toBe(7);
  });
});
