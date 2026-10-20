import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SongDto } from "../../contracts/models";
import { pythonClient } from "../../services/pythonClient";
import { LibraryProvider } from "../../app/LibraryProvider";
import { useLibrarySongs } from "./useLibrarySongs";

vi.mock("../../app/ServicesContext", () => ({
  useServices: () => ({ pythonEpoch: 0 }),
}));
vi.mock("../../services/pythonClient", () => ({
  pythonClient: {
    listSongs: vi.fn(),
    updateSong: vi.fn(),
    removeSongCover: vi.fn(),
    importSong: vi.fn(),
    deleteSong: vi.fn(),
    processSong: vi.fn(),
  },
}));

const song = (title: string): SongDto => ({
  id: "s",
  title,
  artist: "A",
  language: "Auto",
  status: "ready",
  durationSeconds: 1,
  createdAt: "2026-01-01",
  coverState: "Fallback",
  activeRevision: 1,
  projectFormatVersion: 1,
});

describe("useLibrarySongs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requests lyrics realignment and refreshes the existing song", async () => {
    vi.mocked(pythonClient.listSongs).mockResolvedValue([song("Existing")]);
    const { result } = renderHook(() => useLibrarySongs(), { wrapper: LibraryProvider });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(() => result.current.processSong(song("Existing"), "lyrics"));
    expect(pythonClient.processSong).toHaveBeenCalledWith("s", "lyrics");
    expect(pythonClient.listSongs).toHaveBeenCalledTimes(2);
  });

  it("rerenders with the saved song even when a following background list is stale", async () => {
    vi.mocked(pythonClient.listSongs).mockResolvedValue([song("Old")]);
    vi.mocked(pythonClient.updateSong).mockResolvedValue(song("New"));
    const { result } = renderHook(() => useLibrarySongs(), { wrapper: LibraryProvider });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(() => result.current.updateSong(song("Old"), { title: "New" }));

    expect(
      result.current.state.status === "ready" &&
        result.current.state.songs[0]?.title,
    ).toBe("New");
  });

  it("keeps a removed cover when an earlier background refresh finishes late", async () => {
    const old = { ...song("Song"), artworkUrl: "old-cover.jpg" };
    const saved = { ...song("Song"), artworkUrl: undefined };
    let finishRefresh!: (songs: SongDto[]) => void;
    vi.mocked(pythonClient.listSongs)
      .mockResolvedValueOnce([old])
      .mockImplementationOnce(
        () => new Promise<SongDto[]>((resolve) => {
          finishRefresh = resolve;
        }),
      );
    vi.mocked(pythonClient.removeSongCover).mockResolvedValue(saved);
    const { result } = renderHook(() => useLibrarySongs(), { wrapper: LibraryProvider });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    await act(() => result.current.removeSongCover(old));
    act(() => finishRefresh([old]));
    await act(() => refresh);

    expect(
      result.current.state.status === "ready" &&
        result.current.state.songs[0]?.artworkUrl,
    ).toBeUndefined();
  });

  it("shows byte-independent import job progress in the library and removes it after cancellation", async () => {
    vi.mocked(pythonClient.listSongs).mockResolvedValue([]);
    let rejectImport!: (error: Error) => void;
    vi.mocked(pythonClient.importSong).mockImplementation(
      async (_path, _metadata, options) => {
        options?.onProgress({
          jobId: "job-1",
          stage: "Hashing",
          progress: 0.2,
        });
        return new Promise<SongDto>((_resolve, reject) => {
          rejectImport = reject;
        });
      },
    );
    const { result } = renderHook(() => useLibrarySongs(), { wrapper: LibraryProvider });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const controller = new AbortController();

    let importing!: Promise<SongDto>;
    act(() => {
      importing = result.current.importSong("D:/Music/demo.wav", undefined, {
        signal: controller.signal,
        onProgress: vi.fn(),
      });
    });
    await waitFor(() =>
      expect(
        result.current.state.status === "ready" &&
          result.current.state.songs[0],
      ).toMatchObject({
        status: "importing",
        stage: "Hashing",
        progress: 0.2,
        jobId: "job-1",
      }),
    );
    act(() => rejectImport(new Error("cancelled")));
    await expect(importing).rejects.toThrow("cancelled");
    await waitFor(() =>
      expect(
        result.current.state.status === "ready" && result.current.state.songs,
      ).toEqual([]),
    );
  });

  it("shows an error when a background refresh supersedes the first load and fails", async () => {
    let finishInitial!: (songs: SongDto[]) => void;
    vi.mocked(pythonClient.listSongs)
      .mockImplementationOnce(() => new Promise<SongDto[]>((resolve) => { finishInitial = resolve; }))
      .mockRejectedValueOnce(new Error("backend disconnected"));
    const { result } = renderHook(() => useLibrarySongs(), { wrapper: LibraryProvider });
    await act(() => result.current.refresh());
    await act(async () => { finishInitial([song("Old")]); });

    expect(result.current.state.status).toBe("error");
  });

  it("keeps a pending import and its cancellation job during a background refresh", async () => {
    const existing = { ...song("Existing"), id: "existing" };
    vi.mocked(pythonClient.listSongs).mockResolvedValue([existing]);
    let finish!: (value: SongDto) => void;
    vi.mocked(pythonClient.importSong).mockImplementationOnce((_path, _metadata, options) => {
      options?.onProgress({ jobId: "pending-import", stage: "Hashing", progress: 0.2 });
      return new Promise((resolve) => { finish = resolve; });
    });
    const { result } = renderHook(() => useLibrarySongs(), { wrapper: LibraryProvider });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    let importing!: Promise<SongDto>;
    act(() => { importing = result.current.importSong("D:/Music/pending.wav", undefined, {
      signal: new AbortController().signal, onProgress: vi.fn(),
    }); });
    await act(() => result.current.refresh());
    expect(result.current.state).toMatchObject({ status: "ready", songs: [
      { status: "importing", jobId: "pending-import", stage: "Hashing", progress: 0.2 }, existing,
    ] });

    vi.mocked(pythonClient.listSongs).mockResolvedValue([song("Imported"), existing]);
    await act(async () => { finish(song("Imported")); await importing; });
    expect(result.current.state).toEqual({ status: "ready", songs: [song("Imported"), existing] });
  });

  it("replaces an imported placeholder with the saved song even if the list refresh fails", async () => {
    vi.mocked(pythonClient.listSongs).mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("backend disconnected"));
    vi.mocked(pythonClient.importSong).mockResolvedValueOnce(song("Imported"));
    const { result } = renderHook(() => useLibrarySongs(), { wrapper: LibraryProvider });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(() => result.current.importSong("D:/Music/imported.wav"));
    expect(result.current.state).toEqual({ status: "ready", songs: [song("Imported")] });
  });

  it("removes a confirmed deletion even when its follow-up list refresh fails", async () => {
    const remaining = { ...song("Keep"), id: "keep" };
    vi.mocked(pythonClient.listSongs).mockResolvedValueOnce([song("Delete"), remaining])
      .mockRejectedValueOnce(new Error("backend disconnected"));
    vi.mocked(pythonClient.deleteSong).mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useLibrarySongs(), { wrapper: LibraryProvider });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(() => result.current.deleteSong(song("Delete")));
    expect(result.current.state).toEqual({ status: "ready", songs: [remaining] });
  });

  it("keeps the song when deletion itself fails", async () => {
    vi.mocked(pythonClient.listSongs).mockResolvedValueOnce([song("Keep")]);
    vi.mocked(pythonClient.deleteSong).mockRejectedValueOnce(new Error("file busy"));
    const { result } = renderHook(() => useLibrarySongs(), { wrapper: LibraryProvider });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => { await expect(result.current.deleteSong(song("Keep"))).rejects.toThrow("file busy"); });
    expect(result.current.state).toEqual({ status: "ready", songs: [song("Keep")] });
  });
});
