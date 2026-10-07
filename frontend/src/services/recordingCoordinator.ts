import { desktopBridge } from "./desktopBridge";
import type { KaraokeNoteScore, SongDto } from "../contracts/models";

interface RecordingTarget {
  recordingId: string;
  filePath: string;
}
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
  const numericFields = [
    "sampleRate",
    "channels",
    "durationFrames",
    "startSessionFrame",
    "stopSessionFrame",
    "startPlaybackPosition",
    "overrunCount",
    "gapMetadataDropped",
    "staleBlocks",
  ] as const;
  const validNumber = (number: unknown): number is number =>
    typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
  if (
    !value ||
    typeof value !== "object" ||
    !numericFields.every((field) => validNumber(value[field])) ||
    !value.sampleRate ||
    !value.channels ||
    !Array.isArray(value.gaps) ||
    value.gaps.length > 1024 ||
    !value.gaps.every(
      (gap) =>
        gap && validNumber(gap.startFrame) && validNumber(gap.frameCount),
    )
  ) {
    throw new Error("AudioService returned invalid recording metadata");
  }
  return value as NativeRecordingResult;
};

let active: {
  target: RecordingTarget;
  song: SongDto;
  prepared: boolean;
  startedAt: number | null;
  /** When the take was paused (the paused stretch is not in the file), and how long earlier pauses lasted. */
  pausedAt: number | null;
  pausedMilliseconds: number;
  playbackAdjustments: TimedPlaybackAdjustment[];
  karaokeNoteScore: KaraokeNoteScore;
  finalizedPath?: string;
  nativeResult?: NativeRecordingResult;
} | null = null;

interface RecordingStatus {
  recording: boolean;
  recordingId?: string;
}
let flight: { key: string; promise: Promise<RecordingStatus> } | null = null;
let pendingTransitions = 0;
const transition = (
  key: string,
  work: () => Promise<RecordingStatus>,
): Promise<RecordingStatus> => {
  if (flight?.key === key) return flight.promise;
  if (pendingTransitions >= 32)
    return Promise.reject(new Error("Recording command queue is full"));
  pendingTransitions++;
  const promise = (flight?.promise ?? Promise.resolve())
    .catch(() => undefined)
    .then(work);
  flight = { key, promise };
  const settled = () => {
    pendingTransitions--;
    if (flight?.promise === promise) flight = null;
  };
  void promise.then(settled, settled);
  return promise;
};

const python = async <T>(request: PythonBridgeRequest): Promise<T> => {
  const response = await desktopBridge().pythonRequest(request);
  if (!response.ok) throw new Error("Python backend request failed");
  return response.body as T;
};

const audio = async (
  command: string,
  args?: AudioBridgeRequest["args"],
): Promise<string> => {
  const response = await desktopBridge().audioRequest({ command, args });
  if (response.status !== 0)
    throw new Error(response.text || `AudioService command failed: ${command}`);
  return response.text;
};

const discardTarget = async (target: RecordingTarget): Promise<void> => {
  const response = await desktopBridge().pythonRequest({
    method: "DELETE",
    path: `/recordings/${encodeURIComponent(target.recordingId)}`,
  });
  if (!response.ok && response.status !== 404)
    throw new Error("Empty recording cleanup failed");
};

/** Seconds of audio in the take so far: wall time since the start without the paused stretches. */
const takeSeconds = (take: NonNullable<typeof active>): number => {
  if (take.startedAt === null) return 0;
  const now = take.pausedAt ?? performance.now();
  return Math.max(0, (now - take.startedAt - take.pausedMilliseconds) / 1000);
};

/** The song moment the take is expected to be at now, from its latest tempo/position entry. */
const expectedSourceSeconds = (take: NonNullable<typeof active>): number => {
  const last = take.playbackAdjustments.at(-1);
  if (!last) return 0;
  return (
    last.sourceSeconds +
    (takeSeconds(take) - last.elapsedSeconds) * last.playbackRate
  );
};

/** A jump bigger than this (a seek, a room correction, a recovery) starts a new timeline entry. */
const repositionToleranceSeconds = 0.25;

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
  current.finalizedPath ??=
    (await audio("StopRecording")) || current.target.filePath;
  current.nativeResult ??= nativeRecordingResult(
    await audio("GetRecordingState", { details: true }),
  );
  if (current.nativeResult.durationFrames === 0) {
    await discardTarget(current.target);
    active = null;
    return { recording: false };
  }
  const info = await desktopBridge().inspectWave(current.finalizedPath);
  const native = current.nativeResult;
  if (
    native.sampleRate !== info.sampleRate ||
    native.channels !== info.channels ||
    Math.abs(native.durationFrames / native.sampleRate - info.durationSeconds) >
      1 / info.sampleRate
  ) {
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
      sessionMetadata: {
        playbackAdjustments: current.playbackAdjustments,
        karaokeNoteScore: current.karaokeNoteScore,
        nativeRecording: native,
      },
    },
  });
  active = null;
  return { recording: false, recordingId: current.target.recordingId };
};

export const recordingCoordinator = {
  hasPendingTake: () => active !== null || pendingTransitions > 0,
  start(
    song: SongDto,
    adjustment: PlaybackAdjustment = {
      sourceSeconds: 0,
      playbackRate: 1,
      keyShift: 0,
    },
  ) {
    return transition(`start:${song.id}:${song.activeRevision}`, async () => {
      if (
        active?.finalizedPath ||
        (active &&
          (active.song.id !== song.id ||
            active.song.activeRevision !== song.activeRevision))
      )
        await stop();
      if (!active) {
        const target = await python<RecordingTarget>({
          method: "POST",
          path: "/recordings/target",
        });
        active = {
          target,
          song,
          prepared: false,
          startedAt: null,
          pausedAt: null,
          pausedMilliseconds: 0,
          playbackAdjustments: [{ elapsedSeconds: 0, ...adjustment }],
          karaokeNoteScore: {
            hitNotes: 0,
            totalNotes: 0,
            rhythmAccuracyPercent: 0,
            noteStabilityPercent: 0,
          },
        };
      }
      if (!active.prepared) {
        await audio("PrepareRecording", {
          id: active.target.recordingId,
          path: active.target.filePath,
          tap: "performance",
        });
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
      elapsedSeconds: takeSeconds(active),
      ...adjustment,
    });
  },

  /**
   * The song is paused: the take stops growing, so the singer's silence (or chatter) during the pause is
   * neither saved nor scored against the note the song stopped on.
   */
  pause() {
    return transition("pause", async () => {
      if (
        !active ||
        active.startedAt === null ||
        active.finalizedPath ||
        active.pausedAt !== null
      ) {
        return { recording: active !== null };
      }
      await audio("PauseRecording");
      active.pausedAt = performance.now();
      return { recording: true };
    });
  },

  /** The song plays again, possibly from another moment than where it was paused. */
  resume(adjustment: PlaybackAdjustment) {
    return transition("resume", async () => {
      if (!active || active.pausedAt === null || active.finalizedPath)
        return { recording: active !== null };
      await audio("ResumeRecording");
      active.pausedMilliseconds += performance.now() - active.pausedAt;
      active.pausedAt = null;
      active.playbackAdjustments.push({
        elapsedSeconds: takeSeconds(active),
        ...adjustment,
      });
      return { recording: true };
    });
  },

  /**
   * Called with every playback position while the song plays. A jump away from where the tempo timeline
   * says the song should be (a seek, a room correction) is recorded, so analysis compares each sung
   * moment with the part of the song that was actually playing.
   */
  observePosition(sourceSeconds: number) {
    if (
      !active ||
      active.startedAt === null ||
      active.finalizedPath ||
      active.pausedAt !== null
    )
      return;
    if (
      Math.abs(sourceSeconds - expectedSourceSeconds(active)) <=
      repositionToleranceSeconds
    )
      return;
    const last = active.playbackAdjustments.at(-1);
    active.playbackAdjustments.push({
      elapsedSeconds: takeSeconds(active),
      sourceSeconds,
      playbackRate: last?.playbackRate ?? 1,
      keyShift: last?.keyShift ?? 0,
    });
  },

  updateKaraokeNoteScore(score: KaraokeNoteScore) {
    if (
      !active ||
      active.finalizedPath ||
      !Number.isSafeInteger(score.hitNotes) ||
      !Number.isSafeInteger(score.totalNotes) ||
      score.hitNotes < 0 ||
      score.totalNotes < score.hitNotes ||
      ![score.rhythmAccuracyPercent, score.noteStabilityPercent].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 100,
      )
    )
      return;
    active.karaokeNoteScore = score;
  },

  stop() {
    return transition("stop", stop);
  },
};
