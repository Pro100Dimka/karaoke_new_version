import { describe, expect, it, vi } from "vitest";
import { ensurePerformanceAnalysis } from "./performanceAnalysis";

const result = {
  recordingId: "take-1",
  score: 82,
  pitch: 80,
  rhythm: 84,
  stability: 83,
  summary: "done",
};

describe("ensurePerformanceAnalysis", () => {
  it("starts analysis for a newly stopped partial performance", async () => {
    const latestAnalysis = vi.fn().mockResolvedValue(null);
    const analyzeRecording = vi.fn().mockResolvedValue(result);

    await expect(
      ensurePerformanceAnalysis("take-1", { latestAnalysis, analyzeRecording }),
    ).resolves.toEqual(result);
    expect(analyzeRecording).toHaveBeenCalledWith("take-1");
  });

  it("reuses a completed result without starting duplicate analysis", async () => {
    const latestAnalysis = vi.fn().mockResolvedValue(result);
    const analyzeRecording = vi.fn();

    await expect(
      ensurePerformanceAnalysis("take-1", { latestAnalysis, analyzeRecording }),
    ).resolves.toEqual(result);
    expect(analyzeRecording).not.toHaveBeenCalled();
  });
});
