import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../../services/audioClient";
import { editorApi } from "../editor/editorApi";
import { resolveKaraokeLoad } from "./karaokeLoader";
import { useKaraokeLoadSession } from "./useKaraokeLoadSession";
import { pythonClient } from "../../services/pythonClient";

const services = vi.hoisted(() => ({ pythonEpoch: 0 }));
vi.mock("../../app/ServicesContext", () => ({ useServices: () => services }));
vi.mock("../../services/pythonClient", () => ({ pythonClient: { getSong: vi.fn() } }));

vi.mock("./karaokeLoader", () => ({ resolveKaraokeLoad: vi.fn() }));
vi.mock("../editor/editorApi", () => ({ editorApi: { load: vi.fn() } }));
vi.mock("../../services/audioClient", () => ({ audioClient: {
  capabilities: vi.fn(), prepareSong: vi.fn(), setPlaybackRate: vi.fn(), setPitchShift: vi.fn(), setMixer: vi.fn(),
} }));

describe("karaoke load session", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    services.pythonEpoch = 0;
    vi.mocked(audioClient.capabilities).mockResolvedValue({ microphone: "ready", keyboardLighting: false });
    vi.mocked(audioClient.prepareSong).mockResolvedValue({} as never);
    vi.mocked(audioClient.setPlaybackRate).mockResolvedValue(undefined);
    vi.mocked(audioClient.setPitchShift).mockResolvedValue(undefined);
    vi.mocked(audioClient.setMixer).mockResolvedValue(undefined);
  });

  it("refreshes media URLs after backend restart without restarting native playback", async () => {
    const song = { id: "song", status: "ready", videoUrl: "http://127.0.0.1:50000/clip" } as never;
    vi.mocked(resolveKaraokeLoad).mockResolvedValue({ load: { kind: "ready", song }, prefs: {} as never });
    vi.mocked(editorApi.load).mockResolvedValue(null as never);
    const prepared = vi.fn();
    const restart = vi.fn();
    const { result, rerender } = renderHook(() => useKaraokeLoadSession(
      "song", "Normal", { music: 1, mic: 1, reference: 0, melody: 0 }, prepared, vi.fn(), restart,
    ));
    await waitFor(() => expect(prepared).toHaveBeenCalledOnce());
    vi.mocked(pythonClient.getSong).mockResolvedValue({ id: "song", status: "ready", videoUrl: "http://127.0.0.1:51000/clip" } as never);
    services.pythonEpoch++;
    rerender();
    await waitFor(() => expect(result.current.load).toMatchObject({ kind: "ready", song: { videoUrl: "http://127.0.0.1:51000/clip" } }));
    expect(audioClient.prepareSong).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
  });

  it("does not prepare a departed session after its delayed document arrives", async () => {
    const song = { id: "song", status: "ready" } as never;
    vi.mocked(resolveKaraokeLoad).mockResolvedValue({ load: { kind: "ready", song }, prefs: {} as never });
    let finish!: () => void;
    vi.mocked(editorApi.load).mockReturnValue(new Promise(resolve => { finish = () => resolve(null as never); }));
    const prepared = vi.fn();
    const { unmount } = renderHook(() => useKaraokeLoadSession(
      "song", "Normal", { music: 1, mic: 1, reference: 0, melody: 0 }, prepared, vi.fn(),
    ));
    await waitFor(() => expect(editorApi.load).toHaveBeenCalledOnce());
    unmount();
    await act(async () => { finish(); });
    expect(audioClient.prepareSong).not.toHaveBeenCalled();
    expect(prepared).not.toHaveBeenCalled();
  });

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
