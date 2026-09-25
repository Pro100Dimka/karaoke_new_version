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

interface NativeRecordingResult {
  sampleRate: number;
  channels: number;
  durationFrames: number;
  startSessionFrame: number;
  stopSessionFrame: number;
  startPlaybackPosition: number;
  overrunCount: number;
  gapMetadataDropped: number;
  staleBlocks: number;
  gaps: { startFrame: number; frameCount: number }[];
}

const nativeRecordingResult = (text: string): NativeRecordingResult => {
  const value = JSON.parse(text) as Partial<NativeRecordingResult> | null;
  const numericFields = ["sampleRate", "channels", "durationFrames", "startSessionFrame", "stopSessionFrame",
    "startPlaybackPosition", "overrunCount", "gapMetadataDropped", "staleBlocks"] as const;
  const validNumber = (number: unknown): number is number => typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
  if (!value || typeof value !== "object" || !numericFields.every(field => validNumber(value[field])) ||
      !value.sampleRate || !value.channels || !Array.isArray(value.gaps) || value.gaps.length > 1024 ||
      !value.gaps.every(gap => gap && validNumber(gap.startFrame) && validNumber(gap.frameCount))) {
    throw new Error("AudioService returned invalid recording metadata");
  }
  return value as NativeRecordingResult;
};

let active: {
  target: RecordingTarget;
  song: SongDto;
  prepared: boolean;
  startedAt: number | null;
  playbackAdjustments: TimedPlaybackAdjustment[];
  finalizedPath?: string;
  nativeResult?: NativeRecordingResult;
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

const discardTarget = async (target: RecordingTarget): Promise<void> => {
  const response = await desktop().pythonRequest({ method: "DELETE", path: `/recordings/${encodeURIComponent(target.recordingId)}` });
  if (!response.ok && response.status !== 404) throw new Error("Empty recording cleanup failed");
};

const stop = async (): Promise<RecordingStatus> => {
  if (!active) return { recording: false };
  const current = active;
  if (!current.prepared) {
    // Prepare may have succeeded before its IPC reply was lost. Close it before deleting only an empty target.
    await audio("StopRecording").catch(() => undefined);
    await discardTarget(current.target);
    active = null;
    return { recording: false };
  }
  current.finalizedPath ??= (await audio("StopRecording")) || current.target.filePath;
  current.nativeResult ??= nativeRecordingResult(await audio("GetRecordingState", { details: true }));
  if (current.nativeResult.durationFrames === 0) {
    await discardTarget(current.target);
    active = null;
    return { recording: false };
  }
  const info = await desktop().inspectWave(current.finalizedPath);
  const native = current.nativeResult;
  if (native.sampleRate !== info.sampleRate || native.channels !== info.channels ||
      Math.abs(native.durationFrames / native.sampleRate - info.durationSeconds) > 1 / info.sampleRate) {
    throw new Error("Recording metadata does not match the saved audio");
  }
  await python({
    method: "POST",
    path: "/recordings",
    headers: { "Idempotency-Key": current.target.recordingId },
    body: {
      recordingId: current.target.recordingId,
      filePath: current.finalizedPath,
      duration: info.durationSeconds,
      sampleRate: info.sampleRate,
      channels: info.channels,
      createdAt: new Date().toISOString(),
      songId: current.song.id,
      songRevision: current.song.activeRevision,
      gaps: native.gaps,
      sessionMetadata: { playbackAdjustments: current.playbackAdjustments, nativeRecording: native }
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
      if (!active) {
        const target = await python<RecordingTarget>({ method: "POST", path: "/recordings/target" });
        active = {
          target,
          song,
          prepared: false,
          startedAt: null,
          playbackAdjustments: [{ elapsedSeconds: 0, ...adjustment }]
        };
      }
      if (!active.prepared) {
        await audio("PrepareRecording", { id: active.target.recordingId, path: active.target.filePath, tap: "performance" });
        active.prepared = true;
      }
      if (active.startedAt !== null) return { recording: true };
      await audio("StartRecording");
      active.startedAt = performance.now();
      return { recording: true };
    });
  },

  updatePlaybackAdjustment(adjustment: PlaybackAdjustment) {
    if (!active || active.startedAt === null || active.finalizedPath) return;
    active.playbackAdjustments.push({
      elapsedSeconds: Math.max(0, (performance.now() - active.startedAt) / 1000),
      ...adjustment
    });
  },

  stop() {
    return transition("stop", stop);
  }
};
