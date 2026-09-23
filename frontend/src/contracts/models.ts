export type SettingsTab = "appearance" | "audio" | "ai" | "advanced";
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
  error?: AppError;
}

export interface DeviceDto {
  id: string;
  name: string;
  kind: "input" | "output";
  channels: number;
}

export type AudioBackendName = "WASAPI Shared" | "WASAPI Exclusive" | "ASIO";

/** What the user asked for; never presented as what the engine actually applied. */
export interface RequestedAudioConfiguration {
  backend: AudioBackendName;
  inputDeviceId?: string;
  outputDeviceId?: string;
  sampleRate: number;
  periodFrames: number;
}

/** What AudioService actually runs with. */
export interface RuntimeAudioConfiguration {
  backend: AudioBackendName;
  sampleRate: number;
  periodFrames: number;
  endpointBufferFrames: number;
  estimatedLatencyMs: number;
}

/** Values reported by the selected device/driver, never a frontend-maintained preset list. */
export interface AudioConfigurationCapabilities {
  sampleRates: readonly number[];
  periodFrames: readonly number[];
  defaultSampleRate: number;
  defaultPeriodFrames: number;
}

export interface AudioCapabilities {
  microphone:
    | "ready"
    | "permission-denied"
    | "privacy-disabled"
    | "missing"
    | "busy";
  keyboardLighting: boolean;
}

export interface PlaybackSnapshot {
  sessionId: string;
  state: "ready" | "playing" | "paused" | "recovering" | "finished";
  positionSeconds: number;
  durationSeconds: number;
  recording: boolean;
  monitoring: boolean;
  inputLevel: number;
  pitchHz?: number;
}

export interface MixerChannelGains {
  music: number;
  mic: number;
  reference: number;
  melody: number;
}

export interface ParticipantDto {
  id: string;
  name: string;
  role: "host" | "participant";
  self: boolean;
  connected: boolean;
  muted: boolean;
  speakingLevel: number;
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
}

export interface RoomStateDto {
  code: string;
  hostId: string;
  songId?: string;
  revision?: number;
  role: "host" | "participant";
  participants: ParticipantDto[];
  transferProgress?: number;
  playbackLocked: boolean;
  playbackState?: "stopped" | "playing" | "paused";
  playbackStartedAt?: string;
  playbackPositionSeconds?: number;
  serverNow?: string;
  radioEnabled?: boolean;
  radioStationId?: string;
  libraryQuery?: string;
  libraryStatus?: string;
  librarySort?: string;
  playbackRate?: number;
  keyShift?: number;
  collaborativeControl?: boolean;
  syncCheckId?: number;
  syncCheckStartedAt?: string;
  sharedSongs?: RoomSongDto[];
}

export interface RecordingDto {
  id: string;
  filePath: string;
  songId: string;
  displayName: string;
  createdAt: string;
  durationSeconds: number;
  analyzed: boolean;
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

export interface ServiceHealth {
  status: "ready" | "unavailable" | "reconnecting" | "incompatible";
  version?: string;
}

export type ModelState = "not-installed" | "downloading" | "ready" | "failed" | "update-available";

export interface ModelDto {
  id: string;
  purpose: string;
  version: string;
  sizeBytes: number;
  state: ModelState;
  selected: boolean;
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
