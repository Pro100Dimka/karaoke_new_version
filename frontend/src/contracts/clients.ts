import type {
  AnalysisDto,
  AiProcessingSettingsDto,
  EnvironmentSettingDto,
  ConfigurationValidationDto,
  KaggleActionDto,
  AudioBackendName,
  AudioCapabilities,
  AudioConfigurationCapabilities,
  BackendDiagnosticsDto,
  HistoryPageDto,
  ModelDto,
  DeviceDto,
  PlaybackSnapshot,
  ProcessingJobDto,
  RecordingDto,
  RoomStateDto,
  RequestedAudioConfiguration,
  RuntimeAudioConfiguration,
  SongDto
} from "./models";

export type RoomReadiness = "MissingSong" | "Downloading" | "Importing" | "Preparing" | "Ready" | "Failed";
export type RoomCommand = "Start" | "Pause" | "Seek" | "Stop";
export interface RoomSharedState {
  radioEnabled: boolean;
  radioStationId: string;
  libraryQuery: string;
  libraryStatus: string;
  librarySort: string;
  playbackRate: number;
  keyShift: number;
  musicGain: number;
  referenceGain: number;
  melodyGain: number;
}
export type MixerChannel = "mic" | "music" | "reference" | "melody" | "remote" | "master";

export interface RemoteVoiceTiming {
  jitterMs: number;
  targetDelayMs: number;
  /** Packets that reached this listener first over the relay server, and directly (cumulative). */
  relayPackets: number;
  directPackets: number;
  /** Packets partly or wholly cut for arriving after their playout time (cumulative). */
  lateCuts: number;
  /** This route is silent because its samples cannot meet the shared room deadline. */
  excluded?: boolean;
}

export interface RoomTimingReport {
  roundTripMs: number;
  deviceLatencyMs: number;
  remotes: Readonly<Record<string, RemoteVoiceTiming>>;
  estimatedVoiceLatencyMs: number;
  /** This listener's measured delay requirement, published before playback starts. */
  requestedVoiceDelayMs?: number;
  /** Fixed server-owned delay applied equally to every participant and backing track. */
  roomPlayoutDelayMs?: number;
  /** How late the other voices play against this singer's song (the room playout delay). */
  voiceDelayMs: number;
  /** Legacy human-leader shift; new rooms leave this at zero. */
  followMs: number;
  /** Frames this computer's output device starved for and filled with silence (cumulative). */
  deviceStarvedFrames: number;
}

export interface SongPatch {
  title?: string;
  artist?: string;
  language?: SongDto["language"];
  coverPath?: string;
}
export interface ImportProgress {
  jobId: string;
  stage: string;
  progress: number;
}
export interface ImportOptions {
  signal: AbortSignal;
  onProgress(value: ImportProgress): void;
}

export type ProjectCompatibility = "Current" | "Upgradeable" | "TooNew" | "Unsupported" | "Invalid";
export type ProjectImportDecision = "SafeOnly" | "AcceptOlder" | "AcceptDivergent";

export interface PythonClient {
  health(): Promise<{ status: "ready" | "unavailable"; version: string; apiVersion: number; instanceId?: string }>;
  listSongs(): Promise<readonly SongDto[]>;
  getSong(songId: string): Promise<SongDto>;
  importSong(path: string, metadata?: ImportMetadata, options?: ImportOptions): Promise<SongDto>;
  exportProject(songId: string, revision: number): Promise<string>;
  importProject(path: string, decision?: ProjectImportDecision): Promise<SongDto>;
  processSong(songId: string): Promise<ProcessingJobDto>;
  cancelProcessing(jobId: string): Promise<void>;
  updateSong(songId: string, patch: SongPatch): Promise<SongDto>;
  removeSongCover(songId: string): Promise<SongDto>;
  projectCompatibility(songId: string, revision: number): Promise<ProjectCompatibility>;
  deleteSong(songId: string): Promise<void>;
  listRecordings(songId: string): Promise<readonly RecordingDto[]>;
  analyzeRecording(recordingId: string): Promise<AnalysisDto>;
  deleteRecording(recordingId: string): Promise<void>;
  renameRecording(recordingId: string, displayName: string): Promise<RecordingDto>;
  latestAnalysis(recordingId: string): Promise<AnalysisDto | null>;
  createStudioMaster(
    recordingId: string,
    onProgress?: (progress: StudioMasterProgress) => void,
  ): Promise<RecordingDto>;
  listModels(): Promise<readonly ModelDto[]>;
  getAiProcessingSettings(): Promise<AiProcessingSettingsDto>;
  updateAiProcessingSettings(value: {
    processingBackend: "Local" | "Kaggle";
    kaggleUrl?: string;
    kaggleToken?: string;
  }): Promise<AiProcessingSettingsDto>;
  listEnvironmentSettings(): Promise<readonly EnvironmentSettingDto[]>;
  updateEnvironmentSetting(key: string, value: string): Promise<EnvironmentSettingDto>;
  verifyEnvironmentSetting(key: string): Promise<EnvironmentSettingDto>;
  verifyKaggleSettings(): Promise<ConfigurationValidationDto>;
  loginKaggle(): Promise<KaggleActionDto>;
  deployKaggle(): Promise<KaggleActionDto>;
  downloadModel(model: ModelDto): Promise<ProcessingJobDto>;
  getJob(jobId: string): Promise<ProcessingJobDto>;
  cancelJob(jobId: string): Promise<void>;
  listJobs(): Promise<readonly ProcessingJobDto[]>;
  diagnostics(): Promise<BackendDiagnosticsDto>;
  history(limit: number, offset: number): Promise<HistoryPageDto>;
  clearCache(): Promise<number>;
  clearTemporaryFiles(): Promise<number>;
}

export interface StudioMasterProgress {
  recordingId: string;
  stage: string;
  progress: number;
}

/** Talks to the shared room/voice server (a fixed public deployment), not the user's local Python backend. */
export interface RoomClient {
  createRoom(displayName: string): Promise<RoomStateDto>;
  joinRoom(code: string, displayName: string): Promise<RoomStateDto>;
  getRoom(code: string): Promise<RoomStateDto>;
  watchRoom(
    code: string,
    onRoom: (room: RoomStateDto) => void,
    onError: (error: unknown) => void,
  ): () => void;
  leaveRoom(code: string): Promise<void>;
  transferHost(code: string, targetParticipantId: string): Promise<RoomStateDto>;
  removeParticipant(code: string, targetParticipantId: string): Promise<RoomStateDto>;
  closeRoom(code: string): Promise<void>;
  selectRoomSong(code: string, songId: string, revision: number): Promise<RoomStateDto>;
  clearRoomSong(code: string): Promise<RoomStateDto>;
  setRoomReadiness(code: string, readiness: RoomReadiness, progress?: number): Promise<RoomStateDto>;
  setVoiceLatency(code: string, voiceLatencyMs: number): Promise<RoomStateDto>;
  /** Uploads this computer's audio diagnostics to the room server's per-room log. */
  publishDiagnostics(code: string, values: Readonly<Record<string, string>>): Promise<void>;
  roomControl(code: string, command: RoomCommand, positionSeconds?: number): Promise<RoomStateDto>;
  startSyncCheck(code: string): Promise<RoomStateDto>;
  updateSharedState(code: string, state: RoomSharedState): Promise<RoomStateDto>;
  setCollaborativeControl(code: string, enabled: boolean): Promise<RoomStateDto>;
  publishLibrary(code: string, songs: readonly SongDto[]): Promise<RoomStateDto>;
}

export interface AudioServiceClient {
  health(): Promise<{ status: "ready" | "unavailable"; version: string }>;
  listDevices(): Promise<readonly DeviceDto[]>;
  capabilities(): Promise<AudioCapabilities>;
  configurationCapabilities(configuration: RequestedAudioConfiguration): Promise<AudioConfigurationCapabilities>;
  runtimeConfiguration(): Promise<RuntimeAudioConfiguration>;
  /** Band levels 0..1 of the final mix and backing track, for visual feedback only. */
  spectrum(): Promise<{ bands: readonly number[]; backingBands: readonly number[] }>;
  diagnosticsDump(): Promise<Readonly<Record<string, string>>>;
  setPreferredConfiguration(configuration: RequestedAudioConfiguration): void;
  /** Hidden speaker-to-microphone delay (measured) that voices are stamped earlier by. */
  setAcousticLatency(milliseconds: number, context?: string): Promise<void>;
  /** Plays quiet chirps and finds them in the microphone; resolves with the hidden delay in ms. */
  measureAcousticLatency(): Promise<number>;
  /**
   * The hidden delay AudioService found by itself from the song the microphone hears, with the mode
   * it was found in; null until one was found in the running session.
   */
  passiveAcousticLatency(): Promise<{ milliseconds: number; backend: AudioBackendName; context: string } | null>;
  applyConfiguration(
    configuration: RequestedAudioConfiguration
  ): Promise<RuntimeAudioConfiguration>;
  loadRadio(url: string): Promise<void>;
  playRadio(): Promise<void>;
  pauseRadio(): Promise<void>;
  stopRadio(): Promise<void>;
  setRadioGain(gain: number): Promise<void>;
  testInputLevel(): Promise<number>;
  playTestSound(): Promise<void>;
  prepareSong(song: SongDto): Promise<PlaybackSnapshot>;
  play(schedule?: { startAtMilliseconds: number; positionSeconds: number }): Promise<PlaybackSnapshot>;
  pause(): Promise<PlaybackSnapshot>;
  seek(positionSeconds: number): Promise<PlaybackSnapshot>;
  stop(): Promise<PlaybackSnapshot>;
  setMonitoring(enabled: boolean): Promise<PlaybackSnapshot>;
  /** Sets a mixer channel from its knob position (0..1); the loudness law is applied here. */
  setMixer(channel: MixerChannel, position: number): Promise<void>;
  monitoringEnabled(): boolean;
  /** The singer's own mute: nothing of the microphone is heard, sent or recorded; volume stays. */
  microphoneEnabled(): boolean;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  /** Silences one participant for this listener only. */
  setParticipantMuted(participantId: string, muted: boolean): Promise<void>;
  participantMuted(participantId: string): boolean;
  setParticipantVolume(participantId: string, gain: number): Promise<void>;
  setParticipantEffect(
    participantId: string,
    effect: "reverb" | "echo" | "delay" | "noiseSuppression" | "octave" | "autoTune",
    value: number,
  ): Promise<void>;
  roomLevels(): Promise<{ local: number; remote: Readonly<Record<string, number>> }>;
  /** Live estimate from device latency, network RTT and each remote adaptive jitter buffer. */
  roomTiming(): Promise<RoomTimingReport>;
  /** Opens this installation's voice session against the shared room server's relay; address stays in Electron Main. */
  joinVoiceSession(roomId: string, participantId: string, serverClockOffsetMilliseconds?: number): Promise<void>;
  synchronizeRoomClock(serverClockOffsetMilliseconds?: number): Promise<void>;
  /** Applies the server-owned playout deadline to backing audio and every remote voice. */
  setRoomPlayoutDelay(milliseconds: number): Promise<void>;
  leaveVoiceSession(): Promise<void>;
  addRemoteParticipant(participantId: string): Promise<void>;
  removeRemoteParticipant(participantId: string): Promise<void>;
  setPlaybackRate(rate: number): Promise<void>;
  setPitchShift(semitones: number): Promise<void>;
  setDspParameter(name: string, value: number): Promise<void>;
  setDspEnabled(enabled: boolean): Promise<void>;
  startRecording(): Promise<PlaybackSnapshot>;
  stopRecording(): Promise<PlaybackSnapshot>;
  playRecording(recordingId: string): Promise<PlaybackSnapshot>;
  pauseRecordingPreview(): Promise<void>;
  seekRecordingPreview(positionSeconds: number): Promise<void>;
  stopRecordingPreview(): Promise<void>;
  setPreviewVolume(gain: number): Promise<void>;
  recordingPreviewStatus(): Promise<RecordingPreviewStatus>;
}

/** State of the take that AudioService currently holds for preview; `recordingId` is null when none was loaded. */
export interface RecordingPreviewStatus {
  recordingId: string | null;
  state: "ready" | "playing" | "paused" | "finished";
  positionSeconds: number;
}

/** Title and artist the user typed for a new song; omitted fields are detected from the file. */
export interface ImportMetadata {
  title?: string;
  artist?: string;
}

export interface DesktopClient extends DesktopApi {}
