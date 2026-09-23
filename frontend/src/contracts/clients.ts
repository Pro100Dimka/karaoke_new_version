import type {
  AnalysisDto,
  AudioCapabilities,
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
}
export type MixerChannel = "mic" | "music" | "reference" | "remote" | "master";

export interface SongPatch {
  title?: string;
  artist?: string;
  language?: SongDto["language"];
  coverPath?: string;
}

export type ProjectCompatibility = "Current" | "Upgradeable" | "TooNew" | "Unsupported" | "Invalid";
export type ProjectImportDecision = "SafeOnly" | "AcceptOlder" | "AcceptDivergent";

export interface PythonClient {
  health(): Promise<{ status: "ready" | "unavailable"; version: string; apiVersion: number }>;
  listSongs(): Promise<readonly SongDto[]>;
  getSong(songId: string): Promise<SongDto>;
  importSong(path: string, metadata?: ImportMetadata): Promise<SongDto>;
  exportProject(songId: string, revision: number): Promise<string>;
  importProject(path: string, decision?: ProjectImportDecision): Promise<SongDto>;
  processSong(songId: string): Promise<ProcessingJobDto>;
  cancelProcessing(jobId: string): Promise<void>;
  updateSong(songId: string, patch: SongPatch): Promise<SongDto>;
  projectCompatibility(songId: string, revision: number): Promise<ProjectCompatibility>;
  deleteSong(songId: string): Promise<void>;
  listRecordings(songId: string): Promise<readonly RecordingDto[]>;
  analyzeRecording(recordingId: string): Promise<AnalysisDto>;
  deleteRecording(recordingId: string): Promise<void>;
  latestAnalysis(recordingId: string): Promise<AnalysisDto | null>;
  listModels(): Promise<readonly ModelDto[]>;
  downloadModel(model: ModelDto): Promise<ProcessingJobDto>;
  getJob(jobId: string): Promise<ProcessingJobDto>;
  cancelJob(jobId: string): Promise<void>;
  listJobs(): Promise<readonly ProcessingJobDto[]>;
  diagnostics(): Promise<BackendDiagnosticsDto>;
  history(limit: number, offset: number): Promise<HistoryPageDto>;
  clearCache(): Promise<number>;
  clearTemporaryFiles(): Promise<number>;
}

/** Talks to the shared room/voice server (a fixed public deployment), not the user's local Python backend. */
export interface RoomClient {
  createRoom(displayName: string): Promise<RoomStateDto>;
  joinRoom(code: string, displayName: string): Promise<RoomStateDto>;
  getRoom(code: string): Promise<RoomStateDto>;
  leaveRoom(code: string): Promise<void>;
  selectRoomSong(code: string, songId: string, revision: number): Promise<RoomStateDto>;
  clearRoomSong(code: string): Promise<RoomStateDto>;
  setRoomReadiness(code: string, readiness: RoomReadiness): Promise<RoomStateDto>;
  roomControl(code: string, command: RoomCommand, positionSeconds?: number): Promise<RoomStateDto>;
  updateSharedState(code: string, state: RoomSharedState): Promise<RoomStateDto>;
  publishLibrary(code: string, songs: readonly SongDto[]): Promise<RoomStateDto>;
}

export interface AudioServiceClient {
  health(): Promise<{ status: "ready" | "unavailable"; version: string }>;
  listDevices(): Promise<readonly DeviceDto[]>;
  capabilities(): Promise<AudioCapabilities>;
  runtimeConfiguration(): Promise<RuntimeAudioConfiguration>;
  /** Band levels 0..1 of the final output mix, for visual feedback only. */
  spectrum(): Promise<readonly number[]>;
  diagnosticsDump(): Promise<Readonly<Record<string, string>>>;
  setPreferredConfiguration(configuration: RequestedAudioConfiguration): void;
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
  play(): Promise<PlaybackSnapshot>;
  pause(): Promise<PlaybackSnapshot>;
  seek(positionSeconds: number): Promise<PlaybackSnapshot>;
  stop(): Promise<PlaybackSnapshot>;
  setMonitoring(enabled: boolean): Promise<PlaybackSnapshot>;
  setMixer(channel: MixerChannel, gain: number): Promise<void>;
  setParticipantVolume(participantId: string, gain: number): Promise<void>;
  roomLevels(): Promise<{ local: number; remote: Readonly<Record<string, number>> }>;
  /** Opens this installation's voice session against the shared room server's relay; address stays in Electron Main. */
  joinVoiceSession(roomId: string, participantId: string): Promise<void>;
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
