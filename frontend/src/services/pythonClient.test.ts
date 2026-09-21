import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pythonClient } from "./pythonClient";

type Call = { method: string; path: string; body?: unknown; headers?: Record<string, string> };

const installBridge = (reply: (call: Call) => { status: number; ok: boolean; body: unknown }) => {
  const calls: Call[] = [];
  Object.assign(window, {
    desktop: {
      pythonRequest: vi.fn(async (call: Call) => {
        calls.push(call);
        return reply(call);
      })
    }
  });
  return calls;
};

describe("pythonClient contract", () => {
  beforeEach(() => vi.stubGlobal("crypto", { randomUUID: () => "key-1" }));
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "desktop");
  });

  it("deletes a song with DELETE on its encoded path", async () => {
    const calls = installBridge(() => ({ status: 204, ok: true, body: null }));
    await pythonClient.deleteSong("a/b");
    expect(calls).toEqual([{ method: "DELETE", path: "/songs/a%2Fb", body: undefined, headers: undefined }]);
  });

  it("sends the source path with an idempotency key when importing", async () => {
    const calls = installBridge(() => ({
      status: 201,
      ok: true,
      body: { songId: "s", title: "T", artist: "A", status: "Imported", activeRevision: 1, createdAt: "2026-01-01T00:00:00Z" }
    }));
    await pythonClient.importSong("C:/song.mp3");
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/songs",
      body: { sourcePath: "C:/song.mp3" },
      headers: { "Idempotency-Key": "key-1" }
    });
  });

  it("sends the title and artist the user entered when importing", async () => {
    const calls = installBridge(() => ({
      status: 201,
      ok: true,
      body: { songId: "s", title: "T", artist: "A", status: "Imported", activeRevision: 1, createdAt: "2026-01-01T00:00:00Z" }
    }));
    await pythonClient.importSong("C:/song.mp3", { title: "Кофе", artist: "Нервы" });
    expect(calls[0]).toMatchObject({ body: { sourcePath: "C:/song.mp3", title: "Кофе", artist: "Нервы" } });
  });

  it("follows the cursor until the song list is exhausted", async () => {
    const song = { songId: "s", title: "T", artist: "A", status: "Ready", activeRevision: 1, createdAt: "2026-01-01T00:00:00Z" };
    const calls = installBridge(call => ({
      status: 200,
      ok: true,
      body: call.path.includes("cursor=c1") ? { items: [song], nextCursor: null } : { items: [song], nextCursor: "c1" }
    }));
    const songs = await pythonClient.listSongs();
    expect(songs).toHaveLength(2);
    expect(calls.map(call => call.path).filter(path => path.startsWith("/songs"))).toEqual(["/songs?limit=200", "/songs?limit=200&cursor=c1"]);
  });

  it("maps an error response to an AppError with the backend code and request id", async () => {
    installBridge(() => ({ status: 409, ok: false, body: { code: "RevisionConflict", message: "stale", requestId: "r-1" } }));
    await expect(pythonClient.getSong("s")).rejects.toMatchObject({
      code: "RevisionConflict",
      message: "stale",
      source: "python",
      correlationId: "r-1"
    });
  });

  it("falls back to an HTTP code when the error body is not an object", async () => {
    installBridge(() => ({ status: 503, ok: false, body: null }));
    await expect(pythonClient.getSong("s")).rejects.toMatchObject({ code: "Http503", source: "python" });
  });
});
