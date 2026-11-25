import type {
  PlaybackAdjustment,
  RecordingStatus,
} from '../application/karaoke/KaraokePorts';
import { command } from './audioSession';
import { desktopBridge } from './desktopBridge';
import {
  markSilentRoomSource,
  beginRoomRecordingSource,
  prepareRoomRecordingSources,
} from './roomRecordingSources';
import type { BackendRecording } from './pythonMappers';
import type {
  KaraokeNoteScore,
  PitchFrame,
  RoomPerformanceCompletion,
  RoomPerformanceSummary,
  SongDto,
} from '../contracts/models';

interface RecordingTarget {
  recordingId: string;
  filePath: string;
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
    'sampleRate',
    'channels',
    'durationFrames',
    'startSessionFrame',
    'stopSessionFrame',
    'startPlaybackPosition',
    'overrunCount',
    'gapMetadataDropped',
    'staleBlocks',
  ] as const;
  const validNumber = (number: unknown): number is number =>
    typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  if (
    !value ||
    typeof value !== 'object' ||
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
    throw new Error('AudioService returned invalid recording metadata');
  }
  return value as NativeRecordingResult;
};

let active: {
  interrupted: boolean;
  target: RecordingTarget;
  room?: Pick<RoomPerformanceSummary, 'roomId' | 'performanceId'>;
  song: SongDto;
  prepared: boolean;
  startedAt: number | null;
  /** When the take was paused (the paused stretch is not in the file), and how long earlier pauses lasted. */
  pausedAt: number | null;
  pausedMilliseconds: number;
  playbackAdjustments: TimedPlaybackAdjustment[];
  karaokeNoteScore: KaraokeNoteScore;
  microphoneActive: boolean | null;
  stopping: boolean;
  stopRequestedPath?: string;
  finalizedPath?: string;
  nativeResult?: NativeRecordingResult;
} | null = null;

let generation = 0;
const audio: typeof command = async (...args) => {
  const current = generation;
  const result = await command(...args);
  if (current !== generation)
    throw new Error('Recording audio session was interrupted');
  return result;
};

let flight: { key: string; promise: Promise<RecordingStatus> } | null = null;
const maximumPendingTransitions = 32;
let pendingTransitions = 0;
let reconfigurationId = 0;

interface CaptureBoundary {
  accepted: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  reconfigured: Promise<void>;
}
// Registered when Stop is queued, including a Stop waiting for target allocation/Start.
const pendingStops = new Set<CaptureBoundary>();
const captureBoundary = (): CaptureBoundary => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const accepted = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  void accepted.catch(() => undefined);
  const boundary = {
    accepted,
    resolve,
    reject,
    reconfigured: Promise.resolve(),
  };
  pendingStops.add(boundary);
  return boundary;
};

const transition = (
  key: string,
  work: () => Promise<RecordingStatus>,
): Promise<RecordingStatus> => {
  const current = generation;
  const isStop = key === 'stop';
  key = `${current}:${key}`;
  if (flight?.key === key) return flight.promise;
  if (pendingTransitions >= maximumPendingTransitions)
    return Promise.reject(new Error('Recording command queue is full'));
  pendingTransitions++;
  const promise = (flight?.promise ?? Promise.resolve())
    .catch(() => undefined)
    .then(() =>
      current === generation || isStop ? work() : { recording: false },
    );
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
  if (!response.ok) throw new Error('Python backend request failed');
  return response.body as T;
};

const discardTarget = async (
  target: RecordingTarget,
  discardSilent = false,
): Promise<boolean> => {
  const response = await desktopBridge().pythonRequest({
    method: 'DELETE',
    path: `/recordings/${encodeURIComponent(target.recordingId)}${discardSilent ? '?discard_silent=true' : ''}`,
  });
  if (discardSilent && response.status === 409) return false;
  if (!response.ok && response.status !== 404)
    throw new Error('Empty recording cleanup failed');
  return true;
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

const finalizationPollMilliseconds = 100;
// Bound a stalled writer while allowing a slow full-file conversion. Expiry keeps the take
// and its accepted native path, so retry can resume waiting without publishing a partial file.
const finalizationTimeoutMilliseconds = 120_000;

const finalizeRecording = async (
  take: NonNullable<typeof active>,
  acceptCapture: () => void,
): Promise<string> => {
  const requestedGeneration = generation;
  const assertCurrent = () => {
    if (
      active !== take ||
      take.interrupted ||
      requestedGeneration !== generation
    )
      throw new Error('Recording audio session was interrupted');
  };
  assertCurrent();
  // The capture boundary is drained before this reply; only disk finalization remains.
  take.stopRequestedPath ??=
    (await audio('StopRecording', { async: true })) || take.target.filePath;
  acceptCapture();
  take.pausedAt ??= performance.now();
  const deadline = performance.now() + finalizationTimeoutMilliseconds;
  for (;;) {
    assertCurrent();
    const state = await audio('GetRecordingState');
    assertCurrent();
    if (state === '5') return take.stopRequestedPath;
    if (state === '6') {
      // A failed writer has already stopped: retain its existing, specific diagnostic.
      await audio('StopRecording');
      throw new Error('Recording finalization failed');
    }
    if (state !== '4') throw new Error(`Unexpected recording state: ${state}`);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('Recording finalization timed out');
    await new Promise((resolve) =>
      window.setTimeout(
        resolve,
        Math.min(finalizationPollMilliseconds, remaining),
      ),
    );
  }
};

const saveTake = async (
  roomResult?: RoomPerformanceCompletion,
  onCaptured?: () => Promise<void>,
  acceptCapture: () => void = () => undefined,
): Promise<RecordingStatus> => {
  if (!active) {
    if (roomResult) await markSilentRoomSource(roomResult.summary);
    return { recording: false };
  }
  const current = active;
  const roomPerformance = roomResult?.summary ?? current.room;
  const publishSilence = () => {
    if (roomPerformance)
      void markSilentRoomSource(
        roomPerformance,
        current.room ? current.target.recordingId : undefined,
      ).catch((error: unknown) =>
        console.error('Could not publish the silent room source', error),
      );
  };
  if (current.interrupted) {
    // A transport failure can leave the original writer alive. Close it before recovery.
    // A restarted service has nothing to stop; recovery independently requires an exclusive file lock.
    await audio('StopRecording').catch(() => undefined);
    await python({
      method: 'POST',
      path: `/recordings/${encodeURIComponent(current.target.recordingId)}/recover`,
    });
    active = null;
    return { recording: false };
  }
  if (!current.prepared) {
    // Prepare may have succeeded before its IPC reply was lost. Close it before deleting only an empty target.
    await audio('StopRecording').catch(() => undefined);
    await discardTarget(current.target);
    active = null;
    return { recording: false };
  }
  // Even a lost stop reply must not let a retry resume a writer that may be finalizing.
  current.stopping = true;
  current.finalizedPath ??= await finalizeRecording(current, acceptCapture);
  acceptCapture();
  current.nativeResult ??= nativeRecordingResult(
    await audio('GetRecordingState', { details: true }),
  );
  if (current.nativeResult.durationFrames === 0) {
    publishSilence();
    await discardTarget(current.target);
    active = null;
    return { recording: false };
  }
  if (
    current.microphoneActive === false &&
    current.nativeResult.overrunCount === 0 &&
    current.nativeResult.gapMetadataDropped === 0 &&
    current.nativeResult.gaps.length === 0 &&
    (await discardTarget(current.target, true))
  ) {
    publishSilence();
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
    throw new Error('Recording metadata does not match the saved audio');
  }
  await onCaptured?.();
  const registered = await python<BackendRecording>({
    method: 'POST',
    path: '/recordings',
    headers: { 'Idempotency-Key': current.target.recordingId },
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
        ...(roomPerformance ? { roomPerformance } : {}),
        playbackAdjustments: current.playbackAdjustments.map(
          (adjustment, index) =>
            index === 0
              ? {
                  ...adjustment,
                  sourceSeconds:
                    native.startPlaybackPosition / native.sampleRate,
                }
              : adjustment,
        ),
        karaokeNoteScore: current.karaokeNoteScore,
        nativeRecording: native,
      },
    },
  });
  const recordingId = current.target.recordingId;
  if (registered?.roomSources?.status === 'pending')
    void prepareRoomRecordingSources(recordingId).catch((error: unknown) =>
      console.error('Could not collect room singer sources', error),
    );
  if (roomResult)
    void roomResult.result
      .then((result) =>
        python({
          method: 'PATCH',
          path: `/recordings/${encodeURIComponent(recordingId)}`,
          body: { roomPerformance: result },
        }),
      )
      .catch((error: unknown) =>
        console.error('Could not save room performance result', error),
      );
  active = null;
  return { recording: false, recordingId };
};

const stop = async (
  roomResult?: RoomPerformanceCompletion,
  onCaptured?: () => Promise<void>,
  boundary = captureBoundary(),
): Promise<RecordingStatus> => {
  try {
    const result = await saveTake(roomResult, onCaptured, boundary.resolve);
    boundary.resolve();
    return result;
  } catch (error) {
    boundary.reject(error);
    throw error;
  } finally {
    pendingStops.delete(boundary);
    // A later Start must not race a device change released at this capture boundary.
    await boundary.reconfigured;
  }
};

export const recordingCoordinator = {
  async reconfigure(
    work: (
      format?: Pick<NativeRecordingResult, 'sampleRate' | 'channels'>,
    ) => Promise<void>,
    resumedPosition: () => Promise<number>,
  ): Promise<void> {
    const stopping = pendingStops.values().next().value;
    if (stopping) {
      if (pendingTransitions >= maximumPendingTransitions)
        throw new Error('Recording command queue is full');
      pendingTransitions++;
      const requestedGeneration = generation;
      const result = stopping.reconfigured.then(async () => {
        await stopping.accepted;
        if (requestedGeneration !== generation)
          throw new Error('Recording audio session was interrupted');
        // Capture is drained; the disk worker owns its fixed format independently.
        // Waiting for the whole Stop here would deadlock its queued onCaptured audio work.
        await work();
      });
      stopping.reconfigured = result.catch(() => undefined);
      try {
        await result;
      } finally {
        pendingTransitions--;
      }
      return;
    }
    let executed = false;
    await transition(`reconfigure:${++reconfigurationId}`, async () => {
      executed = true;
      const take = active;
      const preserve = take?.prepared && !take.interrupted && !take.stopping;
      const resume =
        preserve && take.startedAt !== null && take.pausedAt === null;
      if (resume) {
        await audio('PauseRecording');
        take.pausedAt = performance.now();
      }
      try {
        const format = preserve
          ? nativeRecordingResult(
              await audio('GetRecordingState', { details: true, paused: true }),
            )
          : undefined;
        await work(format);
      } finally {
        if (resume && active === take && !take.interrupted) {
          const sourceSeconds = await resumedPosition();
          await audio('ResumeRecording');
          take.pausedMilliseconds +=
            performance.now() - (take.pausedAt ?? performance.now());
          take.pausedAt = null;
          const last = take.playbackAdjustments.at(-1);
          take.playbackAdjustments.push({
            elapsedSeconds: takeSeconds(take),
            sourceSeconds,
            playbackRate: last?.playbackRate ?? 1,
            keyShift: last?.keyShift ?? 0,
          });
        }
      }
      return { recording: active !== null };
    });
    if (!executed) throw new Error('Recording audio session was interrupted');
  },

  interrupt() {
    generation++;
    if (active) {
      active.interrupted = true;
      active.pausedAt ??= performance.now();
    }
  },
  elapsedSeconds: () => (active ? takeSeconds(active) : 0),
  hasPendingTake: () => active !== null || pendingTransitions > 0,
  start(
    song: SongDto,
    adjustment: PlaybackAdjustment = {
      sourceSeconds: 0,
      playbackRate: 1,
      keyShift: 0,
    },
    room?: Pick<RoomPerformanceSummary, 'roomId' | 'performanceId'>,
  ) {
    return transition(`start:${song.id}:${song.activeRevision}`, async () => {
      const requestedGeneration = generation;
      if (
        active?.interrupted ||
        active?.stopping ||
        (active &&
          (active.song.id !== song.id ||
            active.song.activeRevision !== song.activeRevision))
      )
        await stop();
      if (requestedGeneration !== generation) return { recording: false };
      if (!active) {
        const current = generation;
        const target = await python<RecordingTarget>({
          method: 'POST',
          path: '/recordings/target',
          body: { songId: song.id, songRevision: song.activeRevision },
        });
        active = {
          interrupted: current !== generation,
          target,
          room,
          song,
          prepared: false,
          stopping: false,
          startedAt: null,
          pausedAt: null,
          pausedMilliseconds: 0,
          playbackAdjustments: [{ elapsedSeconds: 0, ...adjustment }],
          microphoneActive: null,
          karaokeNoteScore: {
            hitNotes: 0,
            totalNotes: 0,
            rhythmAccuracyPercent: 0,
            noteStabilityPercent: 0,
          },
        };
        if (active.interrupted)
          throw new Error('Recording audio session was interrupted');
      }
      if (!active.prepared) {
        if (active.room) {
          await beginRoomRecordingSource(
            active.room,
            active.target.recordingId,
          ).catch((error: unknown) =>
            console.error(
              'Could not register the room microphone capture',
              error,
            ),
          );
          if (requestedGeneration !== generation)
            throw new Error('Recording audio session was interrupted');
        }
        await audio('PrepareRecording', {
          id: active.target.recordingId,
          path: active.target.filePath,
          tap: 'performance',
          backing: true,
        });
        active.prepared = true;
      }
      if (active.startedAt !== null) return { recording: true };
      await audio('StartRecording');
      active.startedAt = performance.now();
      return { recording: true };
    });
  },

  updatePlaybackAdjustment(adjustment: PlaybackAdjustment) {
    if (
      !active ||
      active.interrupted ||
      active.startedAt === null ||
      active.stopping
    )
      return;
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
    return transition('pause', async () => {
      if (
        !active ||
        active.interrupted ||
        active.startedAt === null ||
        active.stopping ||
        active.pausedAt !== null
      ) {
        return { recording: active !== null };
      }
      await audio('PauseRecording');
      active.pausedAt = performance.now();
      return { recording: true };
    });
  },

  /** The song plays again, possibly from another moment than where it was paused. */
  resume(adjustment: PlaybackAdjustment) {
    return transition('resume', async () => {
      if (
        !active ||
        active.interrupted ||
        active.pausedAt === null ||
        active.stopping
      )
        return { recording: active !== null };
      await audio('ResumeRecording');
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
      active.interrupted ||
      active.startedAt === null ||
      active.stopping ||
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

  observeMicrophoneActivity(frames: readonly PitchFrame[] | undefined) {
    if (
      !active ||
      active.interrupted ||
      active.stopping ||
      active.startedAt === null ||
      active.pausedAt !== null ||
      !frames?.length ||
      active.microphoneActive === true
    )
      return;
    if (
      frames.some(
        (frame) => frame.audioActive === true || (frame.pitchHz ?? 0) > 0,
      )
    )
      active.microphoneActive = true;
    else if (frames.every((frame) => frame.audioActive === false))
      active.microphoneActive = false;
  },

  updateKaraokeNoteScore(score: KaraokeNoteScore) {
    if (
      !active ||
      active.interrupted ||
      active.stopping ||
      // A view reset at room stop must not erase this take's accumulated measurements.
      (score.expectedPitchSeconds ?? 0) <
        (active.karaokeNoteScore.expectedPitchSeconds ?? 0) ||
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

  stop(
    roomPerformance?: RoomPerformanceCompletion,
    onCaptured?: () => Promise<void>,
  ) {
    if (flight?.key === `${generation}:stop`) return flight.promise;
    if (pendingTransitions >= maximumPendingTransitions)
      return Promise.reject(new Error('Recording command queue is full'));
    const boundary = captureBoundary();
    const result = transition('stop', () =>
      stop(roomPerformance, onCaptured, boundary),
    );
    void result.catch((error: unknown) => {
      boundary.reject(error);
      pendingStops.delete(boundary);
    });
    return result;
  },
};
