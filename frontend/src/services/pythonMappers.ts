import type { PythonClient } from "../contracts/clients";
import type {
  AnalysisDto,
  AppError,
  BackendDiagnosticsDto,
  HistoryPageDto,
  ModelDto,
  ProcessingJobDto,
  RecordingDto,
  SongDto,
  SongStatus
} from "../contracts/models";


export interface BackendSong {
  songId: string;
  title: string;
  artist: string;
  album: string | null;
  genre?: string | null;
  artworkUrl?: string | null;
  videoUrl?: string | null;
  recognitionProvider?: string | null;
  duration: number | null;
  language: string;
  status: string;
  activeRevision: number;
  projectFormatVersion: number;
  coverState: string;
  createdAt: string;
}

export interface SongPage { items: BackendSong[]; nextCursor: string | null; }
export interface BackendJobRef { jobId: string; state: string; }
export interface BackendJob {
  jobId: string;
  type: string;
  state: string;
  entityId: string | null;
  stage: string | null;
  stageProgress: number;
  overallProgress: number;
  error: Record<string, unknown> | null;
  report?: Record<string, unknown> | null;
}
export interface JobPage { items: BackendJob[]; limit: number; offset: number; }
export interface RecordingPage { items: BackendRecording[]; total: number; limit: number; offset: number; }
export interface BackendRecording {
  recordingId: string;
  filePath: string;
  duration: number;
  sampleRate: number;
  channels: number;
  createdAt: string;
  songId: string | null;
  songRevision: number | null;
}
export interface BackendAnalysis {
  analysisId: string;
  recordingId: string;
  songId: string;
  songRevision: number;
  algorithmVersion: string;
  state: string;
  pitchAccuracyPercent: number | null;
  meanSemitoneDeviation: number | null;
  problemRegions: readonly Record<string, number>[];
  error: Record<string, unknown> | null;
}
export const songStatus = (value: string): SongStatus => {
  const normalized = value.toLowerCase();
  if (normalized === "imported" || normalized === "cancelled") return "not-processed";
  if (normalized === "queued") return "queued";
  if (normalized === "processing" || normalized === "cancelling") return "processing";
  if (normalized === "ready") return "ready";
  if (normalized === "failed" || normalized === "sourcemissing") return "failed";
  return "invalid";
};

export const songLanguage = (value: string): SongDto["language"] =>
  value === "Ukrainian" || value === "Russian" || value === "English" ? value : "Auto";

export const coverState = (value: string): SongDto["coverState"] =>
  value === "Custom" || value === "Embedded" ? value : "Fallback";

export const mapSong = (song: BackendSong): SongDto => ({
  id: song.songId,
  title: song.title,
  artist: song.artist,
  album: song.album ?? undefined,
  genre: song.genre ?? undefined,
  artworkUrl: song.artworkUrl ?? undefined,
  videoUrl: song.videoUrl ?? undefined,
  recognitionProvider: song.recognitionProvider ?? undefined,
  language: songLanguage(song.language),
  status: songStatus(song.status),
  durationSeconds: song.duration ?? 0,
  createdAt: song.createdAt,
  coverState: coverState(song.coverState),
  activeRevision: song.activeRevision,
  projectFormatVersion: song.projectFormatVersion
});

export const mapJob = (job: BackendJob | BackendJobRef, songId = ""): ProcessingJobDto => {
  const state = job.state.toLowerCase();
  const mappedState: ProcessingJobDto["state"] =
    state === "running" ? "processing" :
    state === "succeeded" ? "completed" :
    state === "cancelling" ? "cancelling" :
    state === "cancelled" ? "cancelled" :
    state === "interrupted" ? "interrupted" :
    state === "failed" ? "failed" : "queued";
  const full = "overallProgress" in job ? job : null;
  return {
    id: job.jobId,
    type: full?.type ?? "SongProcessing",
    songId: full?.entityId ?? songId,
    state: mappedState,
    stage: full?.stage ?? "Queued",
    progress: full ? Math.round(full.overallProgress * (full.overallProgress <= 1 ? 100 : 1)) : 0,
    error: full?.error ? {
      code: String(full.error.code ?? "ProcessingFailed"),
      message: String(full.error.message ?? "Processing failed"),
      details: JSON.stringify(full.error),
      source: "python"
    } : undefined
  };
};

export const mapRecording = (recording: BackendRecording): RecordingDto => ({
  id: recording.recordingId,
  filePath: recording.filePath,
  songId: recording.songId ?? "",
  displayName: `Recording · ${new Date(recording.createdAt).toLocaleString()}`,
  createdAt: recording.createdAt,
  durationSeconds: recording.duration,
  analyzed: false
});

export const mapAnalysis = (analysis: BackendAnalysis): AnalysisDto => {
  const pitch = analysis.pitchAccuracyPercent ?? 0;
  const deviation = Math.abs(analysis.meanSemitoneDeviation ?? 0);
  const stability = Math.max(0, Math.round(100 - deviation * 20));
  const score = Math.round((pitch + stability) / 2);
  return {
    recordingId: analysis.recordingId,
    score,
    pitch: Math.round(pitch),
    rhythm: stability,
    stability,
    summary: analysis.state === "Succeeded"
      ? `Pitch accuracy ${pitch.toFixed(1)}%, mean deviation ${deviation.toFixed(2)} semitones.`
      : analysis.state
  };
};

export interface BackendModel {
  modelId: string;
  purpose: string;
  version: string;
  size: number;
  state: string;
  selected: boolean;
}

export interface BackendHistoryPage {
  items: {
    eventId: string;
    eventType: string;
    createdAt: string;
    entityId: string | null;
    details: Record<string, unknown> | null;
  }[];
  total: number;
}

export const modelState = (value: string): ModelDto["state"] => {
  const normalized = value.toLowerCase();
  if (normalized === "ready") return "ready";
  if (normalized === "downloading" || normalized === "verifying") return "downloading";
  if (normalized === "failed") return "failed";
  if (normalized === "modelupdateavailable") return "update-available";
  return "not-installed";
};

export const numberAt = (value: unknown, key: string): number => {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const item = record[key];
  return typeof item === "number" ? item : 0;
};

export const objectAt = (value: unknown, key: string): Record<string, unknown> => {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const item = record[key];
  return item && typeof item === "object" ? (item as Record<string, unknown>) : {};
};

export const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;
