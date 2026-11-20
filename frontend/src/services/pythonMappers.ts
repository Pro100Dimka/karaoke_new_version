import type {
  AppError,
  BackendDiagnosticsDto,
  HistoryPageDto,
  AnalysisDto,
  ProcessingJobDto,
  RecordingDto,
  SongDto,
  SongStatus,
} from '../contracts/models';

export interface BackendSong {
  songId: string;
  sourceHash?: string | null;
  projectHash?: string | null;
  title: string;
  artist: string;
  album: string | null;
  genre?: string | null;
  artworkUrl?: string | null;
  videoUrl?: string | null;
  recognitionProvider?: string | null;
  originalFilename?: string | null;
  sourcePath?: string | null;
  detectedBpm?: number | null;
  detectedKey?: string | null;
  duration: number | null;
  language: string;
  status: string;
  activeRevision: number;
  projectFormatVersion: number;
  coverState: string;
  createdAt: string;
}

export interface SongPage {
  items: BackendSong[];
  nextCursor: string | null;
}
export interface BackendJobRef {
  jobId: string;
  state: string;
}
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
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}
/** Percent done; the backend reports either a 0..1 fraction or a percentage. */
export const jobProgress = (job: BackendJob): number =>
  Math.round(job.overallProgress * (job.overallProgress <= 1 ? 100 : 1));
export interface BackendPage<T> {
  items: T[];
  total?: number;
  limit: number;
  offset: number;
}
export interface BackendRecording {
  roomPerformance?: {
    roomId: string;
    performanceId: number;
    overallScore?: number | null;
    status?: 'pending' | 'complete' | 'unavailable' | null;
  } | null;
  recordingId: string;
  filePath: string;
  duration: number;
  sampleRate: number;
  channels: number;
  createdAt: string;
  songId: string | null;
  songRevision: number | null;
  displayName?: string | null;
  fileStatus?: string;
  analysisStatus?: string;
  sourceRecordingId?: string | null;
  sizeBytes: number;
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
  rhythmAccuracyPercent?: number | null;
  noteStabilityPercent?: number | null;
  problemRegions: readonly Record<string, number>[];
  error: Record<string, unknown> | null;
}
/** A backend state (case-insensitive) mapped through a table, or the fallback when unknown. */
const mapped = <T>(
  table: ReadonlyMap<string, T>,
  value: string,
  fallback: T,
): T => table.get(value.toLowerCase()) ?? fallback;

const songStatuses = new Map<string, SongStatus>([
  ['imported', 'not-processed'],
  ['cancelled', 'not-processed'],
  ['queued', 'queued'],
  ['processing', 'processing'],
  ['cancelling', 'processing'],
  ['ready', 'ready'],
  ['failed', 'failed'],
  ['sourcemissing', 'failed'],
]);

const songStatus = (value: string): SongStatus =>
  mapped(songStatuses, value, 'invalid');

const songLanguages = ['Ukrainian', 'Russian', 'English'] as const;
const isSongLanguage = (
  value: string,
): value is (typeof songLanguages)[number] =>
  songLanguages.some((language) => language === value);

export const songLanguage = (value: string): SongDto['language'] =>
  isSongLanguage(value) ? value : 'Auto';

export const coverState = (value: string): SongDto['coverState'] =>
  value === 'Custom' || value === 'Embedded' ? value : 'Fallback';

export const mapSong = (song: BackendSong): SongDto => ({
  id: song.songId,
  sourceHash: song.sourceHash ?? undefined,
  projectHash: song.projectHash ?? undefined,
  title: song.title,
  artist: song.artist,
  album: song.album ?? undefined,
  genre: song.genre ?? undefined,
  artworkUrl: song.artworkUrl ?? undefined,
  videoUrl: song.videoUrl ?? undefined,
  recognitionProvider: song.recognitionProvider ?? undefined,
  filename: song.originalFilename ?? undefined,
  sourcePath: song.sourcePath ?? undefined,
  detectedBpm: song.detectedBpm ?? undefined,
  detectedKey: song.detectedKey ?? undefined,
  language: songLanguage(song.language),
  status: songStatus(song.status),
  durationSeconds: song.duration ?? 0,
  durationKnown: song.duration != null,
  createdAt: song.createdAt,
  coverState: coverState(song.coverState),
  activeRevision: song.activeRevision,
  projectFormatVersion: song.projectFormatVersion,
});

const jobStates = new Map<string, ProcessingJobDto['state']>([
  ['running', 'processing'],
  ['succeeded', 'completed'],
  ['cancelling', 'cancelling'],
  ['cancelled', 'cancelled'],
  ['interrupted', 'interrupted'],
  ['failed', 'failed'],
]);

/** Where a job ran: as reported, else inferred from its providers or from a local processing report. */
const processingBackend = (
  job: BackendJob,
): ProcessingJobDto['processingBackend'] => {
  const reported = (['Local', 'Kaggle', 'Oracle'] as const).find(
    (backend) => backend === job.report?.processingBackend,
  );
  if (reported) return reported;
  const providers = job.report?.providers;
  const providerValues = isObject(providers) ? Object.values(providers) : [];
  if (providerValues.some((value) => String(value).includes('oracle-pc')))
    return 'Oracle';
  if (
    providerValues.some((value) =>
      String(value).toLowerCase().includes('kaggle'),
    )
  )
    return 'Kaggle';
  if (job.type === 'SongProcessing' && job.report) return 'Local';
  return undefined;
};

export const mapJob = (
  job: BackendJob | BackendJobRef,
  songId = '',
): ProcessingJobDto => {
  const full = 'overallProgress' in job ? job : null;
  const timingOperation = full?.report?.timingOperation;
  const report = full?.report;
  return {
    id: job.jobId,
    type: full?.type ?? 'SongProcessing',
    songId: full?.entityId ?? optionalString(report?.songId) ?? songId,
    songTitle:
      typeof report?.songTitle === 'string' ? report.songTitle : undefined,
    songArtist:
      typeof report?.songArtist === 'string' ? report.songArtist : undefined,
    state: mapped(jobStates, job.state, 'queued'),
    stage: full?.stage ?? 'Queued',
    progress: full ? jobProgress(full) : 0,
    createdAt: full?.createdAt,
    startedAt: full?.startedAt ?? undefined,
    finishedAt: full?.finishedAt ?? undefined,
    processingBackend: full ? processingBackend(full) : undefined,
    timingOperation:
      timingOperation === 'lyrics' || timingOperation === 'melody'
        ? timingOperation
        : undefined,
    error: full?.error
      ? {
          code: String(full.error.code ?? 'ProcessingFailed'),
          message: String(full.error.message ?? 'Processing failed'),
          details: JSON.stringify(full.error),
          source: 'python',
        }
      : undefined,
  };
};

export const mapRecording = (recording: BackendRecording): RecordingDto => ({
  roomPerformance: recording.roomPerformance
    ? {
        ...recording.roomPerformance,
        overallScore: recording.roomPerformance.overallScore ?? undefined,
        status: recording.roomPerformance.status ?? undefined,
      }
    : undefined,
  id: recording.recordingId,
  filePath: recording.filePath,
  songId: recording.songId ?? '',
  // An unnamed take is named by the interface, in its language ("Take 2 · …").
  displayName: recording.displayName ?? '',
  createdAt: recording.createdAt,
  durationSeconds: recording.duration,
  sizeBytes: recording.sizeBytes,
  analyzed: recording.analysisStatus === 'Succeeded',
  analysisStatus: (recording.analysisStatus ??
    'NotAnalyzed') as RecordingDto['analysisStatus'],
  fileStatus: (recording.fileStatus ?? 'Ready') as RecordingDto['fileStatus'],
  sourceRecordingId: recording.sourceRecordingId ?? undefined,
});

export const mapAnalysis = (analysis: BackendAnalysis): AnalysisDto => {
  const pitch = analysis.pitchAccuracyPercent ?? 0;
  const deviation = Math.abs(analysis.meanSemitoneDeviation ?? 0);
  const legacyStability = Math.max(0, Math.round(100 - deviation * 20));
  const rhythm = Math.round(analysis.rhythmAccuracyPercent ?? legacyStability);
  const stability = Math.round(
    analysis.noteStabilityPercent ?? legacyStability,
  );
  const score = Math.round((pitch + rhythm + stability) / 3);
  return {
    recordingId: analysis.recordingId,
    score,
    pitch: Math.round(pitch),
    rhythm,
    stability,
    summary:
      analysis.state === 'Succeeded'
        ? `Pitch ${pitch.toFixed(1)}%, rhythm ${rhythm}%, stability ${stability}%, mean deviation ${deviation.toFixed(2)} semitones.`
        : analysis.state,
  };
};

export interface BackendHistoryPage {
  items: {
    eventId: string;
    eventType: string;
    createdAt: string;
    entityId: string | null;
    songId?: string | null;
    details: Record<string, unknown> | null;
  }[];
  total: number;
}

/** Any non-null object, arrays included: backend payloads read field by field. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const numberAt = (value: unknown, key: string): number => {
  const item = isObject(value) ? value[key] : undefined;
  return typeof item === 'number' ? item : 0;
};

export const objectAt = (
  value: unknown,
  key: string,
): Record<string, unknown> => {
  const item = isObject(value) ? value[key] : undefined;
  return isObject(item) ? item : {};
};

export const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

export const mapDiagnostics = (
  raw: unknown,
  version: { backendVersion: string; apiVersion: number },
): BackendDiagnosticsDto => {
  const backend = objectAt(raw, 'backend');
  const ai = objectAt(raw, 'ai');
  const versions = objectAt(raw, 'versions');
  const usage = objectAt(objectAt(raw, 'storage'), 'usage');
  return {
    state: optionalString(backend.state) ?? 'Unknown',
    database: backend.database === true,
    cudaAvailable: ai.cuda_available === true,
    gpuName: optionalString(ai.gpu_name),
    ffmpegVersion: optionalString(ai.ffmpeg_version),
    pytorchVersion: optionalString(ai.pytorch_version),
    interruptedTransactions: numberAt(
      objectAt(raw, 'recovery'),
      'interruptedTransactions',
    ),
    backendVersion: version.backendVersion,
    apiVersion: version.apiVersion,
    dbSchema: numberAt(versions, 'dbSchema'),
    projectFormat: numberAt(versions, 'projectFormat'),
    storage: {
      songs: numberAt(usage, 'songs'),
      models: numberAt(usage, 'models'),
      cache: numberAt(usage, 'cache'),
      recordings: numberAt(usage, 'recordings'),
      temp: numberAt(usage, 'temp'),
      free: numberAt(usage, 'free'),
    },
  };
};

export const mapHistory = (page: BackendHistoryPage): HistoryPageDto => {
  return {
    total: page.total,
    items: page.items.map((item) => ({
      id: item.eventId,
      kind: item.eventType,
      createdAt: item.createdAt,
      songId: item.songId ?? undefined,
      detail: item.details ? JSON.stringify(item.details) : undefined,
    })),
  };
};

export const mapAnalysisFailure = (current: BackendJob): AppError =>
  ({
    code: optionalString(current.error?.code) ?? `Analysis${current.state}`,
    message:
      optionalString(current.error?.message) ?? 'Performance analysis failed',
    source: 'python',
  }) satisfies AppError;

/** Preserve an asynchronous operation's cause just like a failed HTTP response. */
export const mapJobFailure = (
  current: BackendJob,
  label: string,
): AppError => ({
  code: optionalString(current.error?.code) ?? `Job${current.state}`,
  message:
    optionalString(current.error?.message) ??
    `${label} ${current.state.toLowerCase()}`,
  details:
    current.error?.details === undefined
      ? undefined
      : JSON.stringify(current.error.details),
  source: 'python',
});

export const mapPackageFailure = (current: BackendJob): AppError => {
  const error = current.error ?? {};
  return {
    code:
      typeof error.code === 'string' ? error.code : `Package${current.state}`,
    message:
      typeof error.message === 'string'
        ? error.message
        : `Package job ${current.state.toLowerCase()}`,
    details:
      error.details === undefined ? undefined : JSON.stringify(error.details),
    source: 'python',
  } satisfies AppError;
};
