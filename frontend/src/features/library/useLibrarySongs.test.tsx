import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SongDto } from "../../contracts/models";
import { pythonClient } from "../../services/pythonClient";
import { useLibrarySongs } from "./useLibrarySongs";

vi.mock("../../app/ServicesContext", () => ({ useServices: () => ({ pythonEpoch: 0 }) }));
vi.mock("../../services/pythonClient", () => ({ pythonClient: { listSongs: vi.fn(), updateSong: vi.fn() } }));

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
});
