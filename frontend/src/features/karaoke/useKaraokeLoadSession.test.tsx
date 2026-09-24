import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../../services/audioClient";
import { editorApi } from "../editor/editorApi";
import { resolveKaraokeLoad } from "./karaokeLoader";
import { useKaraokeLoadSession } from "./useKaraokeLoadSession";

vi.mock("./karaokeLoader", () => ({ resolveKaraokeLoad: vi.fn() }));
vi.mock("../editor/editorApi", () => ({ editorApi: { load: vi.fn() } }));
vi.mock("../../services/audioClient", () => ({ audioClient: {
  capabilities: vi.fn(), prepareSong: vi.fn(), setPlaybackRate: vi.fn(), setPitchShift: vi.fn(), setMixer: vi.fn(),
} }));

describe("karaoke load session", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prepares document, audio and every mixer channel before releasing the scene", async () => {
    const song = { id: "song", status: "ready" } as never;
    vi.mocked(resolveKaraokeLoad).mockResolvedValue({ load: { kind: "ready", song }, prefs: { language: "Auto" } as never });
    vi.mocked(editorApi.load).mockResolvedValue({ revision: 1, notes: [], lyrics: [] } as never);
    vi.mocked(audioClient.capabilities).mockResolvedValue({ microphone: "ready", keyboardLighting: false });
    vi.mocked(audioClient.prepareSong).mockResolvedValue({} as never);
    vi.mocked(audioClient.setPlaybackRate).mockResolvedValue(undefined);
    vi.mocked(audioClient.setPitchShift).mockResolvedValue(undefined);
    vi.mocked(audioClient.setMixer).mockResolvedValue(undefined);
    const prepared = vi.fn();

    const { result } = renderHook(() => useKaraokeLoadSession(
      "song", "Normal", { music: 0.8, mic: 0.6, reference: 0, melody: 0 }, prepared, vi.fn(),
    ));

    await waitFor(() => expect(result.current.load.kind).toBe("ready"));
    await waitFor(() => expect(prepared).toHaveBeenCalled());
    expect(vi.mocked(audioClient.setMixer).mock.calls).toEqual([
      ["music", 0.8], ["mic", 0.6], ["reference", 0], ["melody", 0],
    ]);
  });
});
