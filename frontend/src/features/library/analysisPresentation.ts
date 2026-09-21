import type { AnalysisDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";

export type AnalysisMetricKey = "pitch" | "rhythm" | "stability";

export interface AnalysisMetric {
  key: AnalysisMetricKey;
  label: MessageKey;
  description: MessageKey;
  advice: MessageKey;
}

export const analysisMetrics: readonly AnalysisMetric[] = [
  { key: "pitch", label: "analysisPitch", description: "analysisPitchHint", advice: "analysisPitchAdvice" },
  { key: "rhythm", label: "analysisRhythm", description: "analysisRhythmHint", advice: "analysisRhythmAdvice" },
  { key: "stability", label: "analysisStability", description: "analysisStabilityHint", advice: "analysisStabilityAdvice" }
];

const grades: readonly (readonly [minimumScore: number, label: MessageKey])[] = [
  [85, "gradeExcellent"],
  [70, "gradeGood"],
  [50, "gradePotential"],
  [-Infinity, "gradePractice"]
];

export const gradeLabel = (score: number): MessageKey => (grades.find(([minimum]) => score >= minimum) ?? grades[grades.length - 1])[1];

/** The weakest of the three metrics is what the singer should practise next. */
export const weakestMetric = (analysis: AnalysisDto): AnalysisMetric =>
  analysisMetrics.reduce((weakest, metric) => (analysis[metric.key] < analysis[weakest.key] ? metric : weakest));
