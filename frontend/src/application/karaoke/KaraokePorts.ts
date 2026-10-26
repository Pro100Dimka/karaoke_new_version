import type { AudioServiceClient, PythonClient } from "../../contracts/clients";
import type { KaraokeNoteScore, PlaybackSnapshot, SongDto } from "../../contracts/models";

export type KaraokeAudioPort = Pick<AudioServiceClient,
  "capabilities" | "prepareSong" | "setPlaybackRate" | "setPitchShift" |
  "setMixer" | "health" | "seek" | "play" | "pause" | "stop" |
  "setMonitoring" | "setDspParameter" | "setDspEnabled"> & {
  snapshot(): Promise<PlaybackSnapshot>;
};

export type VoiceChainAudioPort = Pick<AudioServiceClient,
  "setMixer" | "setDspParameter" | "setDspEnabled">;

export type KaraokeBackendPort = Pick<PythonClient,
  "getSong" | "projectCompatibility" | "diagnostics">;

export interface KaraokeRecordingPort {
  elapsedSeconds(): number;
  hasPendingTake(): boolean;
  start(song: SongDto, adjustment: PlaybackAdjustment): Promise<RecordingStatus>;
  stop(): Promise<RecordingStatus>;
  pause(): Promise<RecordingStatus>;
  resume(adjustment: PlaybackAdjustment): Promise<RecordingStatus>;
  updatePlaybackAdjustment(adjustment: PlaybackAdjustment): void;
  observePosition(seconds: number): void;
  updateKaraokeNoteScore(score: KaraokeNoteScore): void;
}

export interface PlaybackAdjustment {
  sourceSeconds: number;
  playbackRate: number;
  keyShift: number;
}

export interface RecordingStatus {
  recording: boolean;
  recordingId?: string;
}
