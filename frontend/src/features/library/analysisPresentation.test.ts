import { describe, expect, it } from "vitest";
import type { AnalysisDto } from "../../contracts/models";
import { gradeLabel, weakestMetric } from "./analysisPresentation";

const analysis = (pitch: number, rhythm: number, stability: number): AnalysisDto => ({ recordingId: "r", score: 0, pitch, rhythm, stability, summary: "" });

describe("analysis presentation", () => {
  it("maps the overall score to a grade", () => {
    expect(gradeLabel(90)).toBe("gradeExcellent");
    expect(gradeLabel(70)).toBe("gradeGood");
    expect(gradeLabel(55)).toBe("gradePotential");
    expect(gradeLabel(10)).toBe("gradePractice");
  });

  it("recommends practising the weakest metric", () => {
    expect(weakestMetric(analysis(80, 40, 90)).key).toBe("rhythm");
    expect(weakestMetric(analysis(10, 40, 90)).key).toBe("pitch");
  });
});
