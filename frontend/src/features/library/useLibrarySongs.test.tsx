import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SongDto } from "../../contracts/models";
import { pythonClient } from "../../services/pythonClient";
import { useLibrarySongs } from "./useLibrarySongs";

vi.mock("../../app/ServicesContext", () => ({ useServices: () => ({ pythonEpoch: 0 }) }));
vi.mock("../../services/pythonClient", () => ({ pythonClient: {
  listSongs: vi.fn(), updateSong: vi.fn(), importSong: vi.fn(),
} }));

const song = (title: string): SongDto => ({ id: "s", title, artist: "A", language: "Auto", status: "ready", durationSeconds: 1, createdAt: "2026-01-01", coverState: "Fallback", activeRevision: 1, projectFormatVersion: 1 });

describe("useLibrarySongs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rerenders with the saved song even when a following background list is stale", async () => {
    vi.mocked(pythonClient.listSongs).mockResolvedValue([song("Old")]);
    vi.mocked(pythonClient.updateSong).mockResolvedValue(song("New"));
    const { result } = renderHook(() => useLibrarySongs());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(() => result.current.updateSong(song("Old"), { title: "New" }));

    expect(result.current.state.status === "ready" && result.current.state.songs[0]?.title).toBe("New");
  });

  it("shows byte-independent import job progress in the library and removes it after cancellation", async () => {
    vi.mocked(pythonClient.listSongs).mockResolvedValue([]);
    let rejectImport!: (error: Error) => void;
    vi.mocked(pythonClient.importSong).mockImplementation(async (_path, _metadata, options) => {
      options?.onProgress({ jobId: "job-1", stage: "Hashing", progress: 0.2 });
      return new Promise<SongDto>((_resolve, reject) => { rejectImport = reject; });
    });
    const { result } = renderHook(() => useLibrarySongs());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const controller = new AbortController();

    let importing!: Promise<SongDto>;
    act(() => {
      importing = result.current.importSong("D:/Music/demo.wav", undefined, {
        signal: controller.signal,
        onProgress: vi.fn(),
      });
    });
    await waitFor(() => expect(result.current.state.status === "ready" && result.current.state.songs[0]).toMatchObject({
      status: "importing", stage: "Hashing", progress: 0.2, jobId: "job-1",
    }));
    act(() => rejectImport(new Error("cancelled")));
    await expect(importing).rejects.toThrow("cancelled");
    await waitFor(() => expect(result.current.state.status === "ready" && result.current.state.songs).toEqual([]));
  });
});
