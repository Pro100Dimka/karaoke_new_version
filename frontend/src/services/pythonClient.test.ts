import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pythonClient } from "./pythonClient";

type Call = {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};

const installBridge = (
  reply: (call: Call) => { status: number; ok: boolean; body: unknown },
) => {
  const calls: Call[] = [];
  Object.assign(window, {
    desktop: {
      pythonRequest: vi.fn(async (call: Call) => {
        calls.push(call);
        return reply(call);
      }),
    },
  });
  return calls;
};

describe("pythonClient contract", () => {
  const model = {
    id: "test-model",
    purpose: "ASR",
    version: "1",
    sizeBytes: 100,
    state: "not-installed",
    selected: true,
  } as const;

  it("reuses backend job waiting to report a model download through completion", async () => {
    const progress = vi.fn();
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body: call.path.endsWith("/download")
        ? { jobId: "model-job", state: "Queued" }
        : { jobId: "model-job", state: "Succeeded", overallProgress: 1 },
    }));
    await expect(
      pythonClient.downloadModel(model, progress),
    ).resolves.toMatchObject({ id: "model-job", state: "completed" });
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ id: "model-job", state: "queued" }),
    );
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "completed", progress: 100 }),
    );
    expect(calls.map((call) => call.path)).toEqual([
      "/models/test-model/1/download",
      "/jobs/model-job",
    ]);
  });

  it("keeps the existing immediate model-download contract without a progress callback", async () => {
    const calls = installBridge(() => ({
      status: 202,
      ok: true,
      body: { jobId: "model-job", state: "Queued" },
    }));
    await expect(pythonClient.downloadModel(model)).resolves.toMatchObject({
      state: "queued",
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [
      "Failed",
      { message: "Checksum mismatch" },
      { message: "Checksum mismatch" },
    ],
    ["Cancelled", null, { name: "AbortError" }],
  ])("preserves model download outcome %s", async (state, error, expected) => {
    installBridge((call) => ({
      status: 200,
      ok: true,
      body: call.path.endsWith("/download")
        ? { jobId: "model-job", state: "Queued" }
        : { jobId: "model-job", state, error, overallProgress: 0 },
    }));
    await expect(
      pythonClient.downloadModel(model, vi.fn()),
    ).rejects.toMatchObject(expected);
  });

  it("reports the job identity and analysis stage while waiting", async () => {
    const progress = vi.fn();
    installBridge((call) => ({ status: 200, ok: true, body:
      call.path.endsWith("/analysis") ? { jobId: "job" } :
      call.path === "/jobs/job" ? { jobId: "job", state: "Succeeded", stage: "Scoring", overallProgress: 1 } :
      [{ analysisId: "result", recordingId: "take", state: "Succeeded", pitchAccuracyPercent: 100 }],
    }));
    await pythonClient.analyzeRecording("take", progress);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ recordingId: "take", jobId: "job", stage: "Scoring", progress: 100 }));
  });

  it("opens the newest successful analysis in the backend's newest-first history", async () => {
    installBridge(() => ({ status: 200, ok: true, body: [
      { analysisId: "running", recordingId: "take", state: "Running" },
      { analysisId: "new", recordingId: "take", state: "Succeeded", pitchAccuracyPercent: 95, rhythmAccuracyPercent: 94, noteStabilityPercent: 93 },
      { analysisId: "old", recordingId: "take", state: "Succeeded", pitchAccuracyPercent: 2, rhythmAccuracyPercent: 3, noteStabilityPercent: 4 },
    ] }));
    await expect(pythonClient.latestAnalysis("take")).resolves.toMatchObject({ pitch: 95, rhythm: 94, stability: 93 });
  });

  it("opens the analysis returned by its completed job rather than another result in history", async () => {
    installBridge((call) => ({ status: 200, ok: true, body:
      call.path === "/recordings/take/analysis" ? { jobId: "job" } :
      call.path === "/jobs/job" ? { jobId: "job", state: "Succeeded", report: { analysisId: "wanted" } } : [
        { analysisId: "other", recordingId: "take", state: "Succeeded", pitchAccuracyPercent: 95 },
        { analysisId: "wanted", recordingId: "take", state: "Succeeded", pitchAccuracyPercent: 88 },
        { analysisId: "old", recordingId: "take", state: "Succeeded", pitchAccuracyPercent: 2 },
      ] }));
    await expect(pythonClient.analyzeRecording("take")).resolves.toMatchObject({ pitch: 88 });
  });
  it("preserves the reason an offline performance cannot be scored reliably", async () => {
    installBridge((call) => ({ status: 200, ok: true, body: call.path.startsWith("/jobs/")
      ? { jobId: "analysis-job", state: "Failed", error: { code: "AnalysisPitchUncertain", message: "Too little reliable pitch" } }
      : { jobId: "analysis-job" } }));
    await expect(pythonClient.analyzeRecording("take")).rejects.toMatchObject({
      code: "AnalysisPitchUncertain", source: "python",
    });
  });
  it("keeps waiting for CPU vocal analysis beyond five minutes", async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let polls = 0;
    installBridge((call) => {
      let body: unknown = { jobId: "analysis-job" };
      if (call.path === "/jobs/analysis-job") {
        polls += 1;
        now = 301_000;
        body = { jobId: "analysis-job", state: polls === 1 ? "Running" : "Succeeded" };
      }
      if (call.path.endsWith("/analyses")) body = [{
        analysisId: "result", recordingId: "take", state: "Succeeded",
        pitchAccuracyPercent: 100, rhythmAccuracyPercent: 100, noteStabilityPercent: 100,
        sectionResults: [], problemRegions: [],
      }];
      return { status: 200, ok: true, body };
    });
    try {
      const result = pythonClient.analyzeRecording("take").then(
        (value) => ({ value }), (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toMatchObject({ value: { recordingId: "take" } });
      expect(polls).toBe(2);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });
  it("realigns existing lyrics from the vocal stem with its own processing endpoint", async () => {
    const calls = installBridge(() => ({
      status: 202, ok: true, body: { jobId: "lyrics-1", state: "Queued" },
    }));
    expect(await pythonClient.processSong("a/b", "lyrics")).toMatchObject({
      id: "lyrics-1", songId: "a/b", state: "queued",
    });
    expect(calls).toEqual([{
      method: "POST", path: "/songs/a%2Fb/processing/lyrics",
      body: { mode: "Auto", onlineLyrics: true },
      headers: { "Idempotency-Key": "key-1" },
    }]);
  });

  it("keeps the lyrics realignment operation when loading jobs for retry", async () => {
    installBridge(() => ({ status: 200, ok: true, body: { items: [{
      jobId: "lyrics-1", type: "SongProcessing", entityId: "s", state: "Failed",
      stage: "ForcedAlignment", stageProgress: 0, overallProgress: 0,
      error: null, report: { timingOperation: "lyrics" },
    }], limit: 100, offset: 0 } }));
    expect(await pythonClient.listJobs()).toEqual([
      expect.objectContaining({ id: "lyrics-1", timingOperation: "lyrics" }),
    ]);
  });

  it("propagates the authoritative backend instance identity", async () => {
    installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === "/health/ready"
          ? { ok: true, instanceId: "backend-generation" }
          : { backendVersion: "1", apiVersion: 1 },
    }));
    expect(await pythonClient.health()).toMatchObject({
      instanceId: "backend-generation",
    });
  });
  beforeEach(() => vi.stubGlobal("crypto", { randomUUID: () => "key-1" }));
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "desktop");
  });

  it("deletes a song with DELETE on its encoded path", async () => {
    const calls = installBridge(() => ({ status: 204, ok: true, body: null }));
    await pythonClient.deleteSong("a/b");
    expect(calls).toEqual([
      {
        method: "DELETE",
        path: "/songs/a%2Fb",
        body: undefined,
        headers: undefined,
      },
    ]);
  });

  it("sends the source path with an idempotency key when importing", async () => {
    const calls = installBridge((call) => ({
      status: call.path === "/songs/imports" ? 202 : 200,
      ok: true,
      body:
        call.path === "/songs/imports"
          ? { jobId: "import-1", state: "Queued" }
          : call.path === "/jobs/import-1"
            ? {
                jobId: "import-1",
                type: "SongImport",
                state: "Succeeded",
                entityId: null,
                stage: "Saving",
                stageProgress: 1,
                overallProgress: 1,
                error: null,
                report: { songId: "s" },
              }
            : {
                songId: "s",
                title: "T",
                artist: "A",
                status: "Imported",
                activeRevision: 1,
                createdAt: "2026-01-01T00:00:00Z",
              },
    }));
    await pythonClient.importSong("C:/song.mp3");
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/songs/imports",
      body: { sourcePath: "C:/song.mp3" },
      headers: { "Idempotency-Key": "key-1" },
    });
  });

  it("follows an import by its pushed changes and cancels it at once when aborted", async () => {
    let push: (event: unknown) => void = () => undefined;
    const running = {
      jobId: "import-1",
      type: "SongImport",
      state: "Running",
      entityId: null,
      stage: "Decoding",
      stageProgress: 0.5,
      overallProgress: 0.5,
      error: null,
    };
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === "/songs/imports"
          ? { jobId: "import-1", state: "Queued" }
          : running,
    }));
    Object.assign(window.desktop!, {
      onBackendEvent: (listener: (event: unknown) => void) => {
        push = listener;
        return () => {
          push = () => undefined;
        };
      },
    });
    const controller = new AbortController();
    const progress = vi.fn();
    const importing = pythonClient.importSong(
      "C:/song.mp3",
      {},
      { signal: controller.signal, onProgress: progress },
    );
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ progress: 50 }),
      ),
    );

    push({ type: "job.changed", data: { jobId: "import-1" } });
    await vi.waitFor(() =>
      expect(
        calls.filter((call) => call.path === "/jobs/import-1"),
      ).toHaveLength(2),
    );

    const startedAt = Date.now();
    controller.abort();
    await expect(importing).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/jobs/import-1/cancel",
    });
  });

  it("sends the title and artist the user entered when importing", async () => {
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === "/songs/imports"
          ? { jobId: "import-1", state: "Queued" }
          : call.path === "/jobs/import-1"
            ? {
                jobId: "import-1",
                type: "SongImport",
                state: "Succeeded",
                entityId: null,
                stage: "Saving",
                stageProgress: 1,
                overallProgress: 1,
                error: null,
                report: { songId: "s" },
              }
            : {
                songId: "s",
                title: "T",
                artist: "A",
                status: "Imported",
                activeRevision: 1,
                createdAt: "2026-01-01T00:00:00Z",
              },
    }));
    await pythonClient.importSong("C:/song.mp3", {
      title: "Кофе",
      artist: "Нервы",
    });
    expect(calls[0]).toMatchObject({
      body: { sourcePath: "C:/song.mp3", title: "Кофе", artist: "Нервы" },
    });
  });

  it("follows the cursor until the song list is exhausted", async () => {
    const song = {
      songId: "s",
      title: "T",
      artist: "A",
      status: "Ready",
      activeRevision: 1,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body: call.path.includes("cursor=c1")
        ? { items: [song], nextCursor: null }
        : { items: [song], nextCursor: "c1" },
    }));
    const songs = await pythonClient.listSongs();
    expect(songs).toHaveLength(2);
    expect(
      calls
        .map((call) => call.path)
        .filter((path) => path.startsWith("/songs")),
    ).toEqual(["/songs?limit=200", "/songs?limit=200&cursor=c1"]);
  });

  it("maps an error response to an AppError with the backend code and request id", async () => {
    installBridge(() => ({
      status: 409,
      ok: false,
      body: { code: "RevisionConflict", message: "stale", requestId: "r-1" },
    }));
    await expect(pythonClient.getSong("s")).rejects.toMatchObject({
      code: "RevisionConflict",
      message: "stale",
      source: "python",
      correlationId: "r-1",
    });
  });

  it("falls back to an HTTP code when the error body is not an object", async () => {
    installBridge(() => ({ status: 503, ok: false, body: null }));
    await expect(pythonClient.getSong("s")).rejects.toMatchObject({
      code: "Http503",
      source: "python",
    });
  });

  it("waits for package export and returns the generated archive path", async () => {
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === "/packages/export/song-1?revision=3"
          ? { jobId: "job-export", state: "Queued" }
          : {
              jobId: "job-export",
              state: "Succeeded",
              report: { path: "D:/packages/song-1.zip" },
            },
    }));

    await expect(pythonClient.exportProject("song-1", 3)).resolves.toBe(
      "D:/packages/song-1.zip",
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /packages/export/song-1?revision=3",
      "GET /jobs/job-export",
    ]);
  });

  it("waits for a downloaded package import and returns the imported song", async () => {
    const song = {
      songId: "song-2",
      title: "Shared",
      artist: "Friend",
      status: "Ready",
      activeRevision: 4,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === "/packages/import"
          ? { jobId: "job-import", state: "Queued" }
          : call.path === "/jobs/job-import"
            ? {
                jobId: "job-import",
                state: "Succeeded",
                report: { songId: "song-2" },
              }
            : song,
    }));

    await expect(
      pythonClient.importProject("D:/downloads/song-2.zip"),
    ).resolves.toMatchObject({ id: "song-2", activeRevision: 4 });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /packages/import",
      "GET /jobs/job-import",
      "GET /songs/song-2",
    ]);
  });

  it("can accept an older exact room revision when local history is newer", async () => {
    const song = {
      songId: "song-2",
      title: "Shared",
      artist: "Friend",
      status: "Ready",
      activeRevision: 3,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const calls = installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === "/packages/import"
          ? { jobId: "job-import", state: "Queued" }
          : call.path === "/jobs/job-import"
            ? {
                jobId: "job-import",
                state: "Succeeded",
                report: { songId: "song-2" },
              }
            : song,
    }));

    await pythonClient.importProject("D:/downloads/song-2.zip", "AcceptOlder");
    expect(calls[0]).toMatchObject({
      body: { path: "D:/downloads/song-2.zip", decision: "AcceptOlder" },
    });
  });

  it("reports why a package import failed, with the backend's own code", async () => {
    installBridge((call) => ({
      status: 200,
      ok: true,
      body:
        call.path === "/packages/import"
          ? { jobId: "job-import", state: "Queued" }
          : {
              jobId: "job-import",
              state: "Failed",
              error: {
                code: "PackageConflict",
                message: "Package conflicts with local project",
                details: { conflict: "DivergentRevision" },
              },
            },
    }));

    await expect(
      pythonClient.importProject("D:/downloads/song-2.zip", "AcceptOlder"),
    ).rejects.toMatchObject({
      code: "PackageConflict",
      details: JSON.stringify({ conflict: "DivergentRevision" }),
      source: "python",
    });
  });
});
