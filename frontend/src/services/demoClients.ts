import type { AudioServiceClient, PythonClient } from "../contracts/clients";
import type {
  AnalysisDto,
  PlaybackSnapshot,
  ProcessingJobDto,
  RecordingDto,
  RoomStateDto,
  RuntimeAudioConfiguration,
  SongDto,
} from "../contracts/models";
import { demoParticipants, demoSongs } from "./demoData";

let songs = [...demoSongs];
let playback: PlaybackSnapshot = {
  sessionId: "demo",
  state: "ready",
  positionSeconds: 0,
  durationSeconds: 246,
  recording: false,
  monitoring: false,
  inputLevel: 0.24,
  pitchHz: 220,
};
let runtime: RuntimeAudioConfiguration = {
  backend: "WASAPI Shared",
  inputDeviceId: "mic-1",
  outputDeviceId: "out-1",
  sampleRate: 48000,
  periodFrames: 256,
  estimatedLatencyMs: 18.7,
};
let recordings: RecordingDto[] = [
  {
    id: "take-1",
    songId: "boombox-people",
    displayName: "Take 3 · 2026-09-18 12:44",
    createdAt: "2026-09-18T12:44:00",
    durationSeconds: 242,
    analyzed: true,
  },
  {
    id: "take-2",
    songId: "boombox-people",
    displayName: "Take 2 · 2026-09-17 21:16",
    createdAt: "2026-09-17T21:16:00",
    durationSeconds: 239,
    analyzed: false,
  },
];

const findSong = (songId: string): SongDto => {
  const song = songs.find((item) => item.id === songId);
  if (!song) throw new Error("Song not found");
  return song;
};

export const pythonClient: PythonClient = {
  async health() {
    return { status: "ready", version: "demo-1.0" };
  },

  async listSongs() {
    return songs;
  },

  async importSong(path) {
    const title =
      path
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "Imported song";
    const song: SongDto = {
      id: `import-${Date.now()}`,
      title,
      artist: "Unknown artist",
      genre: "Unknown",
      filename: path,
      status: "not-processed",
      difficulty: "medium",
      durationSeconds: 0,
      recordingsCount: 0,
    };
    songs = [song, ...songs];
    return song;
  },

  async processSong(songId) {
    songs = songs.map((song) =>
      song.id === songId
        ? { ...song, status: "processing", progress: 8, stage: "Preparing" }
        : song,
    );
    const job: ProcessingJobDto = {
      id: `job-${songId}`,
      songId,
      state: "processing",
      stage: "Preparing",
      progress: 8,
    };
    return job;
  },

  async cancelProcessing() {},

  async updateSong(songId, patch) {
    songs = songs.map((song) =>
      song.id === songId ? { ...song, ...patch } : song,
    );
    return findSong(songId);
  },

  async deleteSong(songId) {
    songs = songs.filter((song) => song.id !== songId);
  },

  async listRecordings(songId) {
    return recordings.filter((recording) => recording.songId === songId);
  },

  async analyzeRecording(recordingId) {
    const result: AnalysisDto = {
      recordingId,
      score: 87,
      pitch: 91,
      rhythm: 84,
      stability: 86,
      summary: "Strong pitch accuracy with a few late phrase entries.",
    };
    return result;
  },

  async deleteRecording(recordingId) {
    recordings = recordings.filter((recording) => recording.id !== recordingId);
  },

  async createRoom() {
    const room: RoomStateDto = {
      code: "AD-4821",
      role: "host",
      participants: [...demoParticipants],
      transferProgress: 72,
      playbackLocked: false,
    };
    return room;
  },

  async joinRoom(code, displayName) {
    const room: RoomStateDto = {
      code: code.toUpperCase(),
      role: "participant",
      participants: [
        {
          id: "me",
          name: displayName,
          role: "participant",
          self: true,
          muted: false,
          speakingLevel: 0,
          volume: 1,
          readiness: "ready",
        },
      ],
      playbackLocked: false,
    };
    return room;
  },
  getSong: function (songId: string): Promise<SongDto> {
    throw new Error("Function not implemented.");
  },
};

const nextPlayback = (patch: Partial<PlaybackSnapshot>): PlaybackSnapshot => {
  playback = { ...playback, ...patch };
  return playback;
};

export const audioClient: AudioServiceClient = {
  async health() {
    return { status: "ready", version: "demo-1.0" };
  },

  async listDevices() {
    return [
      { id: "mic-1", name: "Default Microphone", kind: "input", channels: 2 },
      { id: "out-1", name: "Default Speakers", kind: "output", channels: 2 },
    ];
  },

  async capabilities() {
    return { microphone: "ready", keyboardLighting: true };
  },

  async runtimeConfiguration() {
    return runtime;
  },

  async applyConfiguration(value) {
    runtime = value;
    return runtime;
  },

  async testInputLevel() {
    return 0.64;
  },

  async playTestSound() {},

  async prepareSong(song) {
    return nextPlayback({
      state: "ready",
      positionSeconds: 0,
      durationSeconds: song.durationSeconds,
    });
  },

  async play() {
    return nextPlayback({ state: "playing" });
  },

  async pause() {
    return nextPlayback({ state: "paused" });
  },

  async seek(positionSeconds) {
    return nextPlayback({ positionSeconds });
  },

  async stop() {
    return nextPlayback({
      state: "finished",
      positionSeconds: 0,
      recording: false,
    });
  },

  async setMonitoring(monitoring) {
    return nextPlayback({ monitoring });
  },

  async setMixer() {},
  async setParticipantVolume() {},
  async setPlaybackRate() {},
  async setPitchShift() {},
  async setDspParameter() {},
  async setDspEnabled() {},

  async startRecording() {
    return nextPlayback({ recording: true });
  },

  async stopRecording() {
    return nextPlayback({ recording: false });
  },

  async pauseRecordingPreview() {},
  async seekRecordingPreview() {},
  async stopRecordingPreview() {},
  async setPreviewVolume() {},
  async recordingPreviewStatus() {
    return { recordingId: null, state: "ready" as const, positionSeconds: 0 };
  },

  async playRecording() {
    return nextPlayback({ state: "playing", positionSeconds: 0 });
  },
};
