import { describe, expect, it } from "vitest";
import { buildDiagnosticsReport } from "./diagnosticsReport";

describe("buildDiagnosticsReport", () => {
  it("marks unavailable subsystems explicitly instead of hiding them", () => {
    const report = JSON.parse(
      buildDiagnosticsReport({
        frontendVersion: "1.0.0",
        generatedAt: "2026-01-01T00:00:00Z",
        backend: null,
        audio: { ServiceState: "Running" },
        keyboardLighting: false,
      }),
    ) as Record<string, unknown>;

    expect(report.pythonBackend).toBe("unavailable");
    expect(report.audioService).toEqual({ ServiceState: "Running" });
    expect(report.keyboardLighting).toContain("unsupported");
    expect(report.failedProcessing).toBe("unavailable");
  });

  it("includes the latest failed processing with its stage and error, newest first", () => {
    const failed = (id: string, finishedAt: string) => ({
      id,
      type: "SongProcessing",
      songId: "song",
      state: "failed" as const,
      stage: "Separation",
      progress: 0.4,
      finishedAt,
      error: {
        code: "CudaOutOfMemory",
        message: "CUDA out of memory",
        source: "python" as const,
      },
    });
    const report = JSON.parse(
      buildDiagnosticsReport({
        frontendVersion: "1.0.0",
        generatedAt: "2026-01-01T00:00:00Z",
        backend: null,
        audio: null,
        keyboardLighting: false,
        jobs: [
          failed("old", "2026-01-01T10:00:00Z"),
          {
            ...failed("done", "2026-01-02T10:00:00Z"),
            state: "completed",
            error: undefined,
          },
          failed("new", "2026-01-03T10:00:00Z"),
        ],
      }),
    ) as {
      failedProcessing: {
        finishedAt: string;
        stage: string;
        error: { code: string };
      }[];
    };

    expect(report.failedProcessing.map((job) => job.finishedAt)).toEqual([
      "2026-01-03T10:00:00Z",
      "2026-01-01T10:00:00Z",
    ]);
    expect(report.failedProcessing[0]).toMatchObject({
      stage: "Separation",
      error: { code: "CudaOutOfMemory" },
    });
  });
});
