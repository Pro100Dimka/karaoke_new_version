export type SettingsTab =
  "appearance" | "audio" | "ai" | "environment" | "advanced";
export type ThemeName = "dark" | "light" | "green" | "violet";
export type Language = "uk" | "ru" | "en";
export type SongStatus =
  | "not-processed"
  | "queued"
  | "processing"
  | "ready"
  | "failed"
  | "importing"
  | "invalid";
export type SongLanguage = "Auto" | "Ukrainian" | "Russian" | "English";
export type CoverState = "Embedded" | "Custom" | "Fallback";

export interface KaraokeNoteScore {
  /** Present only for the timestamped live scorer; legacy UI counters are not final analysis. */
  version?: 3;
  expectedPitchSeconds?: number;
  assessedPitchSeconds?: number;
  pitchAccuracyPercent?: number;
  meanSemitoneDeviation?: number;
  hitNotes: number;
  totalNotes: number;
  rhythmAccuracyPercent: number;
  noteStabilityPercent: number;
}

export interface SongDto {
  id: string;
  title: string;
  artist: string;
  album?: string;
  genre?: string;
  artworkUrl?: string;
  videoUrl?: string;
  recognitionProvider?: string;
  language: SongLanguage;
  filename?: string;
  detectedBpm?: number;
  detectedKey?: string;
  status: SongStatus;
  progress?: number;
  stage?: string;
  jobId?: string;
  durationSeconds: number;
  createdAt: string;
  coverState: CoverState;
  activeRevision: number;
  projectFormatVersion: number;
  roomOwnerId?: string;
}

export interface RoomSongDto {
  ownerParticipantId: string;
  songId: string;
  revision: number;
  title: string;
  artist: string;
  album?: string;
  genre?: string;
  durationSeconds: number;
}

export interface ProcessingJobDto {
  id: string;
  type: string;
  songId: string;
  songTitle?: string;
  songArtist?: string;
  state:
    | "queued"
    | "processing"
    | "cancelling"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  stage: string;
  progress: number;
  startedAt?: string;
  finishedAt?: string;
  processingBackend?: "Local" | "Kaggle";
  timingOperation?: "lyrics" | "melody";
  error?: AppError;
}

export interface DeviceDto {
  id: string;
  name: string;
  kind: "input" | "output";
  channels: number;
  backend: AudioBackendName;
}

export type AudioBackendName = "WASAPI Shared" | "WASAPI Exclusive" | "ASIO";

export const unverifiedAsioMonitoring = "ASIO4ALL_MONITORING_UNVERIFIED";

/** What the user asked for; never presented as what the engine actually applied. */
export interface RequestedAudioConfiguration {
  backend: AudioBackendName;
  /** True when the user explicitly chose ASIO; a legacy ASIO4ALL profile has no such marker. */
  userSelectedAsio?: boolean;
  inputDeviceId?: string;
  outputDeviceId?: string;
  sampleRate: number;
  /** Shared-mode engine period. */
  periodFrames: number;
  /** Optional user-selected capture period; 0/undefined follows the render request. */
  inputPeriodFrames?: number;
  /** Exclusive/ASIO hardware buffer, kept independently from the shared period. */
  bufferFrames?: number;
  /**
   * Windows only: the user asked for "minimum microphone latency" (the microphone opened
   * exclusively, output still shared). A wish: the runtime reports whether it took effect.
   */
  lowLatencyInput?: boolean;
}

/** What AudioService actually runs with. */
export interface RuntimeAudioConfiguration {
  /** Active endpoint route; "" means system default, undefined means not reported. */
  inputDeviceId?: string;
  outputDeviceId?: string;
  /** Changes whenever the actual audio streams are reopened, including device recovery. */
  calibrationContext?: string;
  calibratedLatencyMs?: number;
  /** Where calibratedLatencyMs came from; "NONE" while the path has none. */
  calibrationOrigin?: "NONE" | "PROFILE" | "TEST_SIGNAL" | "SONG";
  backend: AudioBackendName;
  /** Whether the microphone really runs exclusively for "minimum microphone latency". */
  lowLatencyInputActive?: boolean;
  /** Why a requested exclusive microphone stayed shared; "NONE" when it did not. */
  lowLatencyInputFallback?: string;
  sampleRate: number;
  periodFrames: number;
  inputPeriodFrames?: number;
  selectedInputPeriodFrames?: number;
  requestedInputPeriodFrames?: number;
  inputPeriodMismatchReason?: string;
  selectedPeriodFrames?: number;
  requestedPeriodFrames?: number;
  periodSelectionFallback?: string;
  periodMismatchReason?: string;
  sharedPeriodFallback?: string;
  sharedPeriodLocked?: boolean;
  endpointBufferFrames: number;
  /** Known monitoring delay from the audio system; excludes unreported hardware latency. */
  estimatedLatencyMs: number | null;
  /** Extra USB transport from a supported vendor API; null means unknown, not zero. */
  usbLatency?: { inputMs: number | null; outputMs: number | null };
  /** The parts of estimatedLatencyMs, each from its own source; null where AudioService gave none. */
  latencyParts?: LatencyParts;
  /** Device timeline observation or fallback model; never a full physical loopback measurement. */
  latencyEstimateSource?: "device-timeline" | "driver-model" | "measuring" | "unavailable";
  captureTimestampAdjusted?: boolean;
  /** Callback elapsed times and waiting; NOT additional parts of estimatedLatencyMs. */
  latencyTiming?: {
    renderCallbackP95Ms: number | null;
    captureCallbackP95Ms: number | null;
    jitWaitP95Ms: number | null;
    deadlineOvershootP95Ms: number | null;
  };
}

/** Non-overlapping parts of the monitoring path as AudioService accounts them. */
export interface LatencyParts {
  /** Capture-stamp to delivery: the driver's reported input latency, or one period if it reports none. */
  inputMs: number | null;
  /** The driver's own input figure (GetStreamLatency/ASIO); null when it reports nothing. */
  inputReportedMs: number | null;
  /** Written by the app to the device-reported presentation time of that sample. */
  outputMs: number | null;
  /** Compatibility aggregate: ClockBridge residence + algorithmic DSP delay, NOT CPU time. */
  appMs: number | null;
  bridgeMs?: number | null;
  dspMs?: number | null;
}

/** Values reported by the selected device/driver, never a frontend-maintained preset list. */
export interface AudioConfigurationCapabilities {
  sampleRates: readonly number[];
  periodFrames: readonly number[];
  inputPeriodFrames?: readonly number[];
  inputSampleRate?: number;
  defaultSampleRate: number;
  defaultPeriodFrames: number;
  periodSelectionReason?: string;
}

export interface AudioCapabilities {
  microphone:
    "ready" | "permission-denied" | "privacy-disabled" | "missing" | "busy";
  keyboardLighting: boolean;
}

export interface PitchFrame {
  sequence: number;
  epoch: number;
  positionSeconds: number;
  durationSeconds: number;
  pitchHz?: number;
  /** Audible input includes consonants whose pitch cannot be measured. */
  audioActive?: boolean;
  /** Periodicity of the captured audio; absent only with an older AudioService. */
  confidence?: number;
}

export interface PlaybackSnapshot {
  sessionId: string;
  state: "ready" | "playing" | "paused" | "recovering" | "finished";
  positionSeconds: number;
  durationSeconds: number;
  monitoring: boolean;
  monitoringSafetyTripped?: boolean;
  inputLevel: number;
  pitchHz?: number;
  pitchFrames?: readonly PitchFrame[];
}

export interface MixerChannelGains {
  music: number;
  mic: number;
  reference: number;
  melody: number;
  master: number;
}

export interface ParticipantDto {
  id: string;
  name: string;
  role: "host" | "participant";
  self: boolean;
  connected: boolean;
  muted: boolean;
  volume: number;
  readiness:
    | "missing"
    | "preparing"
    | "downloading"
    | "verifying"
    | "audio"
    | "ready"
    | "failed"
    | "disconnected";
  transferProgress?: number;
  voiceLatencyMs?: number;
  /** Whether this participant has supplied a pre-song end-to-end voice measurement. */
  voiceTimingReady?: boolean;
  /** Whether this route can meet the room's bounded synchronized playout deadline. */
  voiceEligible?: boolean;
}

export interface RoomStateDto {
  code: string;
  hostId: string;
  songId?: string;
  revision?: number;
  role: "host" | "participant";
  participants: ParticipantDto[];
  /** Server-owned delay used by every backing track and remote voice in this room. */
  roomPlayoutDelayMs?: number;
  transferProgress?: number;
  transferId?: string;
  transferBytes?: number;
  transferTotalBytes?: number;
  transferError?: boolean;
  /** The failed import met this singer's own, different copy of the song (see roomProjectDownload). */
  transferConflict?: boolean;
  playbackLocked: boolean;
  playbackState?: "stopped" | "playing" | "paused";
  playbackStartedAt?: string;
  playbackPositionSeconds?: number;
  serverNow?: string;
  /** Server UTC minus local performance.now(), measured at the signaling request midpoint. */
  serverClockOffsetMilliseconds?: number;
  radioEnabled?: boolean;
  radioStationId?: string;
  libraryQuery?: string;
  libraryStatus?: string;
  librarySort?: string;
  playbackRate?: number;
  keyShift?: number;
  musicGain?: number;
  referenceGain?: number;
  melodyGain?: number;
  collaborativeControl?: boolean;
  syncCheckId?: number;
  syncCheckStartedAt?: string;
  sharedSongs?: RoomSongDto[];
  /** Local signaling health; omitted snapshots are treated as connected. */
  connectionStatus?: "connected" | "reconnecting";
}

export interface RecordingDto {
  id: string;
  filePath: string;
  songId: string;
  displayName: string;
  createdAt: string;
  durationSeconds: number;
  sizeBytes: number;
  analyzed: boolean;
  analysisStatus?:
    "NotAnalyzed" | "Queued" | "Running" | "Succeeded" | "Failed" | "Stale";
  fileStatus?: "Ready" | "RecoveredIncomplete" | "Missing" | "Failed";
  /** Present only for a Studio Master derived from an untouched source take. */
  sourceRecordingId?: string;
}

export interface AnalysisDto {
  recordingId: string;
  score: number;
  pitch: number;
  rhythm: number;
  stability: number;
  summary: string;
}

export interface AppError {
  code: string;
  message: string;
  details?: string;
  source: "python" | "audio" | "desktop" | "frontend";
  correlationId?: string;
}
export type ModelState =
  "not-installed" | "downloading" | "ready" | "failed" | "update-available";

export interface ModelDto {
  id: string;
  purpose: string;
  version: string;
  sizeBytes: number;
  state: ModelState;
  selected: boolean;
}

export interface AiProcessingSettingsDto {
  processingBackend: "Local" | "Kaggle";
  kaggleUrl?: string;
  kaggleConfigured: boolean;
}

export interface EnvironmentSettingDto {
  key: string;
  group: "kaggle" | "recognition" | "room" | "deployment" | "runtime";
  kind: "text" | "secret" | "file" | "url" | "port";
  value: string;
  configured: boolean;
  state: "empty" | "valid" | "invalid" | "unverified";
  message: string;
}

export interface ConfigurationValidationDto {
  state: "valid" | "invalid";
  message: string;
}

export interface KaggleActionDto extends ConfigurationValidationDto {
  url?: string;
}

export interface HistoryEventDto {
  id: string;
  kind: string;
  createdAt: string;
  songId?: string;
  detail?: string;
}

export interface HistoryPageDto {
  items: readonly HistoryEventDto[];
  total: number;
}

export interface StorageUsageDto {
  songs: number;
  models: number;
  cache: number;
  recordings: number;
  temp: number;
  free: number;
}

export interface BackendDiagnosticsDto {
  state: string;
  database: boolean;
  cudaAvailable: boolean;
  gpuName?: string;
  ffmpegVersion?: string;
  pytorchVersion?: string;
  interruptedTransactions: number;
  backendVersion: string;
  apiVersion: number;
  dbSchema: number;
  projectFormat: number;
  storage: StorageUsageDto;
}
