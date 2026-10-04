import type { ProcessingJobDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";

type JobState = ProcessingJobDto["state"];

export const stateLabel = {
  queued: "jobQueued",
  processing: "jobProcessing",
  cancelling: "jobCancelling",
  completed: "jobCompleted",
  failed: "failed",
  cancelled: "jobCancelled",
  interrupted: "jobInterrupted",
} as const satisfies Record<JobState, MessageKey>;

/** The LED of each state: done, working, waiting or broken. */
export const stateTone = {
  queued: "pending",
  processing: "processing",
  cancelling: "processing",
  completed: "success",
  failed: "error",
  cancelled: "error",
  interrupted: "error",
} as const satisfies Record<JobState, "pending" | "processing" | "success" | "error">;

export const isActive = (job: ProcessingJobDto) => job.state === "processing" || job.state === "cancelling";
export const isRetryable = (job: ProcessingJobDto) =>
  job.state === "failed" || job.state === "interrupted" || job.state === "cancelled";

/** How long a finished job ran, as m:ss. */
export const processingDuration = (job: ProcessingJobDto): string | undefined => {
  if (!job.startedAt || !job.finishedAt) return undefined;
  const seconds = Math.max(0, Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return undefined;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The pipeline's stages grouped into the phases a singer can follow. */
export const phases = [
  "processingPhasePrepare",
  "processingPhaseSeparate",
  "processingPhaseLyrics",
  "processingPhaseMelody",
  "processingPhasePublish",
] as const satisfies readonly MessageKey[];
const stagePhase: Readonly<Record<string, number>> = {
  DecodeNormalize: 0,
  MusicAnalysis: 0,
  StemSeparation: 1,
  ReferenceVocalPreparation: 1,
  LyricsDiscovery: 2,
  ForcedAlignment: 2,
  MelodyReference: 3,
  ReprocessMelody: 3,
  PitchAnalysis: 3,
  PitchStabilization: 3,
  VoicedIntervalMapping: 3,
  NoteConstruction: 3,
  ProjectValidationPublication: 4,
};
/** Index of the phase the job's current stage belongs to, when it is a known stage. */
export const phaseOf = (job: ProcessingJobDto): number | undefined => stagePhase[job.stage];
