import type {
  RoomClient,
  RoomCommand,
  RoomSharedState,
} from '../../contracts/clients';
import type {
  KaraokeNoteScore,
  RoomPerformanceSummary,
  RoomStateDto,
} from '../../contracts/models';
import type { RoomSessionScope } from './RoomSessionController';

type PlaybackPort = Pick<
  RoomClient,
  | 'roomControl'
  | 'clearRoomSong'
  | 'advancePlaylist'
  | 'updateSharedState'
  | 'setRoomReadiness'
  | 'publishPerformance'
  | 'getRoom'
>;

/** Sends room playback intents in one participation generation. The server owns their timing. */
export class RoomPlaybackCoordinator {
  private latestPerformance?: { id: number; score: KaraokeNoteScore };
  private performancePublishing?: Promise<void>;
  private performanceSentAt = -Infinity;
  private starting?: Promise<RoomStateDto | undefined>;
  private prepared?: {
    key: string;
    state: 'sending' | 'ready';
    promise: Promise<void>;
  };

  constructor(
    private readonly scope: RoomSessionScope,
    private readonly room: PlaybackPort,
  ) {}

  async publishPerformance(
    performanceId: number,
    score: KaraokeNoteScore,
    finished = false,
  ): Promise<void> {
    if (
      !this.scope.isCurrent() ||
      this.scope.getRoom()?.performanceId !== performanceId
    )
      return;
    this.latestPerformance = { id: performanceId, score };
    const sungSeconds = score.assessedPitchSeconds ?? 0;
    if (
      !finished &&
      (sungSeconds <= 0 ||
        this.performancePublishing ||
        Date.now() - this.performanceSentAt < 1_000)
    )
      return;
    if (this.performancePublishing)
      await this.performancePublishing.catch(() => undefined);
    if (
      !this.scope.isCurrent() ||
      this.scope.getRoom()?.performanceId !== performanceId
    )
      return;
    const accuracy = Math.round(
      ((score.pitchAccuracyPercent ?? 0) +
        Math.round(score.rhythmAccuracyPercent) +
        Math.round(score.noteStabilityPercent)) /
        3,
    );
    this.performanceSentAt = Date.now();
    const publishing = this.room.publishPerformance(
      this.scope.code,
      performanceId,
      accuracy,
      sungSeconds,
      finished,
    );
    this.performancePublishing = publishing;
    try {
      await publishing;
    } finally {
      if (this.performancePublishing === publishing)
        this.performancePublishing = undefined;
    }
  }

  async finalPerformance(): Promise<RoomPerformanceSummary | undefined> {
    const id =
      this.latestPerformance?.id ?? this.scope.getRoom()?.performanceId;
    if (id === undefined) return undefined;
    const result: RoomPerformanceSummary = {
      roomId: this.scope.code,
      performanceId: id,
    };
    try {
      if (this.latestPerformance?.id === id)
        await this.publishPerformance(id, this.latestPerformance.score, true);
      const deadline = Date.now() + 5_000;
      while (this.scope.isCurrent() && Date.now() < deadline) {
        const room = await this.room.getRoom(this.scope.code);
        if (room.lastPerformanceId === id)
          return { ...result, overallScore: room.lastPerformanceAccuracy };
        if (room.performanceId !== id) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch {
      // The recording remains available even when the shared result could not be retrieved.
    }
    return result;
  }

  private async commit(
    operation: Promise<RoomStateDto>,
    selected?: Pick<RoomStateDto, 'songId' | 'revision'>,
  ): Promise<RoomStateDto | undefined> {
    const snapshot = await operation;
    const current = this.scope.getRoom();
    if (
      !current ||
      (selected &&
        (current.songId !== selected.songId ||
          current.revision !== selected.revision))
    )
      return undefined;
    return this.scope.setSnapshot(snapshot) ? snapshot : undefined;
  }

  start(): Promise<RoomStateDto | undefined> {
    if (this.starting) return this.starting;
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    const starting = this.commit(
      this.room.roomControl(this.scope.code, 'Start'),
      this.scope.getRoom() ?? undefined,
    );
    this.starting = starting;
    void starting.then(
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
    );
    return starting;
  }

  control(
    command: Exclude<RoomCommand, 'Start'>,
    positionSeconds?: number,
    continuePlaylist = false,
  ): Promise<RoomStateDto | undefined> {
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    return this.commit(
      this.room.roomControl(
        this.scope.code,
        command,
        positionSeconds,
        continuePlaylist,
      ),
      this.scope.getRoom() ?? undefined,
    );
  }

  clearSong(): Promise<RoomStateDto | undefined> {
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    return this.commit(
      this.room.clearRoomSong(this.scope.code),
      this.scope.getRoom() ?? undefined,
    );
  }

  async advancePlaylist(performanceId: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (this.scope.isCurrent()) {
      const current = this.scope.getRoom();
      if (!current?.playlist || current.performanceId !== performanceId) return;
      const snapshot =
        current.playbackState === 'stopped'
          ? await this.room.advancePlaylist(this.scope.code, performanceId)
          : await this.room.getRoom(this.scope.code);
      if (this.scope.getRoom()?.performanceId !== performanceId) return;
      this.scope.setSnapshot(snapshot);
      if (!snapshot.playlist || snapshot.performanceId !== performanceId)
        return;
      if (Date.now() >= deadline)
        throw new Error('Playlist transition timed out');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  updateSharedState(state: RoomSharedState): Promise<RoomStateDto | undefined> {
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    return this.commit(this.room.updateSharedState(this.scope.code, state));
  }

  reportReady(songId: string, revision: number): Promise<void> {
    const current = this.scope.getRoom();
    if (current?.songId !== songId || current.revision !== revision)
      return Promise.resolve();
    const selectionId = current.selectionId ?? 0;
    const key = `${songId}:${revision}:${selectionId}`;
    const readiness = current.participants.find(
      (person) => person.self,
    )?.readiness;
    if (
      this.prepared?.key === key &&
      (this.prepared.state === 'sending' ||
        [undefined, 'ready'].includes(readiness))
    )
      return this.prepared.promise;
    const reporting = {
      key,
      state: 'sending' as 'sending' | 'ready',
      promise: Promise.resolve(),
    };
    this.prepared = reporting;
    reporting.promise = this.room
      .setRoomReadiness(this.scope.code, 'Ready', selectionId, 100)
      .then((snapshot) => {
        if (this.prepared !== reporting) return;
        const latest = this.scope.getRoom();
        if (
          latest?.songId !== songId ||
          latest.revision !== revision ||
          (latest.selectionId ?? 0) !== selectionId
        ) {
          this.prepared = undefined;
          return;
        }
        if (latest === current) this.scope.setSnapshot(snapshot);
        reporting.state = 'ready';
      })
      .catch((error) => {
        if (this.prepared === reporting) this.prepared = undefined;
        throw error;
      });
    return reporting.promise;
  }
}
