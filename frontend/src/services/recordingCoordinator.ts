import type { SongDto } from "../contracts/models";

interface RecordingTarget { recordingId: string; filePath: string; }
export interface PlaybackAdjustment {
  sourceSeconds: number;
  playbackRate: number;
  keyShift: number;
}

interface TimedPlaybackAdjustment extends PlaybackAdjustment {
  elapsedSeconds: number;
}

let active: {
  target: RecordingTarget;
  song: SongDto;
  startedAt: number;
  playbackAdjustments: TimedPlaybackAdjustment[];
  finalizedPath?: string;
} | null = null;

interface RecordingStatus { recording: boolean; recordingId?: string; }
let flight: { key: string; promise: Promise<RecordingStatus> } | null = null;
let pendingTransitions = 0;
const transition = (key: string, work: () => Promise<RecordingStatus>): Promise<RecordingStatus> => {
  if (flight?.key === key) return flight.promise;
  if (pendingTransitions >= 32) return Promise.reject(new Error("Recording command queue is full"));
  pendingTransitions++;
  const promise = (flight?.promise ?? Promise.resolve()).catch(() => undefined).then(work);
  flight = { key, promise };
  const settled = () => {
    pendingTransitions--;
    if (flight?.promise === promise) flight = null;
  };
  void promise.then(settled, settled);
  return promise;
};

const desktop = (): DesktopApi => {
  if (!window.desktop) throw new Error("Desktop bridge is unavailable");
  return window.desktop;
};

const python = async <T>(request: PythonBridgeRequest): Promise<T> => {
  const response = await desktop().pythonRequest(request);
  if (!response.ok) throw new Error("Python backend request failed");
  return response.body as T;
};

const audio = async (command: string, args?: AudioBridgeRequest["args"]): Promise<string> => {
  const response = await desktop().audioRequest({ command, args });
  if (response.status !== 0) throw new Error(response.text || `AudioService command failed: ${command}`);
  return response.text;
};

const stop = async (): Promise<RecordingStatus> => {
  if (!active) return { recording: false };
  const current = active;
  current.finalizedPath ??= (await audio("StopRecording")) || current.target.filePath;
  const info = await desktop().inspectWave(current.finalizedPath);
  await python({
    method: "POST",
    path: "/recordings",
    headers: { "Idempotency-Key": current.target.recordingId },
    body: {
      recordingId: current.target.recordingId,
      filePath: current.finalizedPath,
      duration: Math.max(info.durationSeconds, 0.001),
      sampleRate: info.sampleRate,
      channels: info.channels,
      createdAt: new Date().toISOString(),
      songId: current.song.id,
      songRevision: current.song.activeRevision,
      gaps: [],
      sessionMetadata: { playbackAdjustments: current.playbackAdjustments }
    }
  });
  active = null;
  return { recording: false, recordingId: current.target.recordingId };
};

export const recordingCoordinator = {
  hasPendingTake: () => active !== null || pendingTransitions > 0,
  start(song: SongDto, adjustment: PlaybackAdjustment = { sourceSeconds: 0, playbackRate: 1, keyShift: 0 }) {
    return transition(`start:${song.id}:${song.activeRevision}`, async () => {
      if (active?.finalizedPath || (active && (active.song.id !== song.id || active.song.activeRevision !== song.activeRevision))) await stop();
      if (active) return { recording: true };
      const target = await python<RecordingTarget>({ method: "POST", path: "/recordings/target" });
      await audio("PrepareRecording", { id: target.recordingId, path: target.filePath, tap: "performance" });
      await audio("StartRecording");
      active = {
        target,
        song,
        startedAt: performance.now(),
        playbackAdjustments: [{ elapsedSeconds: 0, ...adjustment }]
      };
      return { recording: true };
    });
  },

  updatePlaybackAdjustment(adjustment: PlaybackAdjustment) {
    if (!active || active.finalizedPath) return;
    active.playbackAdjustments.push({
      elapsedSeconds: Math.max(0, (performance.now() - active.startedAt) / 1000),
      ...adjustment
    });
  },

  stop() {
    return transition("stop", stop);
  }
};
