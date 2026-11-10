import type { AnalysisDto } from '../../../../contracts/models';

export type AnalysisMetricKey = 'pitch' | 'rhythm' | 'stability';

interface AnalysisMetric {
  key: AnalysisMetricKey;
  label: string;
  description: string;
  advice: string;
}

export const analysisMetrics: readonly AnalysisMetric[] = [
  {
    key: 'pitch',
    label: 'analysisPitch',
    description: 'analysisPitchHint',
    advice: 'analysisPitchAdvice',
  },
  {
    key: 'rhythm',
    label: 'analysisRhythm',
    description: 'analysisRhythmHint',
    advice: 'analysisRhythmAdvice',
  },
  {
    key: 'stability',
    label: 'analysisStability',
    description: 'analysisStabilityHint',
    advice: 'analysisStabilityAdvice',
  },
];

const grades: readonly (readonly [minimumScore: number, label: string])[] = [
  [85, 'gradeExcellent'],
  [70, 'gradeGood'],
  [50, 'gradePotential'],
  [-Infinity, 'gradePractice'],
];

export const gradeLabel = (score: number): string =>
  grades.find(([minimum]) => score >= minimum)?.[1] ?? 'gradePractice';

/** The weakest of the three metrics is what the singer should practise next. */
export const weakestMetric = (analysis: AnalysisDto): AnalysisMetric =>
  analysisMetrics.reduce((weakest, metric) =>
    analysis[metric.key] < analysis[weakest.key] ? metric : weakest,
  );
const analysisStages = {
  PreparingRecording: 'recordingPreparing',
  Loading: 'analysisLoading',
  Queued: 'analysisWaitingResources',
  AnalyzingTiming: 'analysisTiming',
  SeparatingPerformance: 'analysisSeparating',
  PitchAnalysis: 'analysisPitchTracking',
  ReferencePitchAnalysis: 'analysisReferenceTracking',
  Scoring: 'analysisScoring',
} as const;

export const analysisStageLabel = (stage: string) =>
  analysisStages[stage as keyof typeof analysisStages] ?? 'analysisRunning';
