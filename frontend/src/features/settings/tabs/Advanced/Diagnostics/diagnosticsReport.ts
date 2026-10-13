import type {
  BackendDiagnosticsDto,
  ProcessingJobDto,
} from "../../../../../contracts/models";

export interface DiagnosticsSnapshot {
  frontendVersion: string;
  generatedAt: string;
  backend: BackendDiagnosticsDto | null;
  audio: Readonly<Record<string, string>> | null;
  keyboardLighting: boolean;
  /** Song processing jobs; the latest failures go into the report with their errors. */
  jobs?: readonly ProcessingJobDto[] | null;
}

const reportedFailures = 5;

/** The latest failed song processing: where it stopped and why, without song names or paths. */
export const failedJobsOf = (jobs: readonly ProcessingJobDto[]) =>
  jobs
    .filter((job) => job.state === "failed" || job.state === "interrupted")
    .sort((a, b) => (b.finishedAt ?? b.startedAt ?? "").localeCompare(a.finishedAt ?? a.startedAt ?? ""))
    .slice(0, reportedFailures)
    .map((job) => ({
      state: job.state,
      stage: job.stage,
      processingBackend: job.processingBackend ?? "Local",
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error
        ? { code: job.error.code, message: job.error.message, details: job.error.details }
        : null,
    }));

/** Technical snapshot only; it never contains song audio, lyrics or recordings. */
export const buildDiagnosticsReport = (snapshot: DiagnosticsSnapshot): string =>
  JSON.stringify(
    {
      application: {
        name: "A&D Voice",
        frontendVersion: snapshot.frontendVersion,
        generatedAt: snapshot.generatedAt,
      },
      pythonBackend: snapshot.backend ?? "unavailable",
      audioService: snapshot.audio ?? "unavailable",
      failedProcessing: snapshot.jobs ? failedJobsOf(snapshot.jobs) : "unavailable",
      keyboardLighting: snapshot.keyboardLighting
        ? "supported"
        : "unsupported: no compatible device",
    },
    null,
    2,
  );
