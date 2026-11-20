import type {
  AudioServiceClient,
  PythonClient,
  RoomClient,
} from '../../contracts/clients';
import type { RoomStateDto, SongDto } from '../../contracts/models';
import { toAppError } from '../../shared/errors';
import {
  roomSnapshotIsOlder,
  type RoomSessionScope,
} from './RoomSessionController';
import { createLatestSnapshotQueue } from './latestSnapshotQueue';
import { roomChimeKinds, type RoomChimeKind } from './roomChime';
import { diffParticipants, hasCurrentParticipant } from './roomModel';
import { preserveLocalRoomTransfer } from './roomProjectDownload';

type RecoveryPorts = {
  room: Pick<RoomClient, 'watchRoom'>;
  audio: Pick<AudioServiceClient, 'leaveVoiceSession'>;
  python: Pick<PythonClient, 'listSongs'>;
  voice: {
    synchronize(
      before: RoomStateDto,
      after: RoomStateDto,
      isCurrent?: () => boolean,
    ): Promise<void>;
  };
  project: {
    reconcileReadiness(
      snapshot: RoomStateDto,
      library: readonly SongDto[],
    ): Promise<void>;
  };
  launch: {
    selectionChanged(room: RoomStateDto): void;
    recordPlaybackTransition(before: RoomStateDto, after: RoomStateDto): void;
    observe(room: RoomStateDto, library: readonly SongDto[]): void;
    stop(): void;
  };
  notify(
    key: string,
    tone: 'info' | 'warning',
    params?: { name: string },
  ): void;
  chime(kind: RoomChimeKind): void;
};

/** Reconciles authoritative snapshots and contains room connection recovery. */
export class RoomRecoveryCoordinator {
  private unsubscribe?: () => void;
  private pythonReady = false;
  private selectionEpoch = 0;
  private selection?: {
    songId?: string;
    revision?: number;
    selectionId?: number;
  };

  constructor(
    private readonly scope: RoomSessionScope,
    private readonly ports: RecoveryPorts,
  ) {
    const current = scope.getRoom();
    this.selection = {
      songId: current?.songId,
      revision: current?.revision,
      selectionId: current?.selectionId,
    };
  }

  setPythonReady(ready: boolean): void {
    const resumed = ready && !this.pythonReady;
    this.pythonReady = ready;
    const current = this.scope.getRoom();
    if (resumed && this.unsubscribe && current) {
      const epoch = this.selectionEpoch;
      void this.reconcileProject(current, epoch).catch((error) =>
        this.onError(error, () => this.current(epoch, current)),
      );
    }
  }

  start(): void {
    if (this.unsubscribe) return;
    const snapshots = createLatestSnapshotQueue<{
      snapshot: RoomStateDto;
      epoch: number;
    }>(async ({ snapshot, epoch }) => this.synchronize(snapshot, epoch));
    this.unsubscribe = this.ports.room.watchRoom(
      this.scope.code,
      (snapshot) => {
        if (
          !this.scope.isCurrent() ||
          snapshot.code !== this.scope.code ||
          roomSnapshotIsOlder(snapshot, this.scope.getRoom())
        )
          return;
        if (
          snapshot.songId !== this.selection?.songId ||
          snapshot.selectionId !== this.selection?.selectionId ||
          snapshot.revision !== this.selection?.revision
        ) {
          this.selection = {
            songId: snapshot.songId,
            revision: snapshot.revision,
            selectionId: snapshot.selectionId,
          };
          ++this.selectionEpoch;
          this.ports.launch.selectionChanged(snapshot);
        }
        void snapshots.push({ snapshot, epoch: this.selectionEpoch });
      },
      (error) => {
        void this.onError(error);
      },
    );
  }

  private current = (epoch: number, snapshot: RoomStateDto): boolean =>
    this.scope.isCurrent() &&
    epoch === this.selectionEpoch &&
    !roomSnapshotIsOlder(snapshot, this.scope.getRoom());

  private markReconnecting(): void {
    const current = this.scope.getRoom();
    if (current && current.connectionStatus !== 'reconnecting')
      this.scope.setSnapshot({ ...current, connectionStatus: 'reconnecting' });
  }

  private async onError(
    error: unknown,
    isCurrent: () => boolean = () => this.scope.isCurrent(),
  ): Promise<void> {
    if (!isCurrent()) return;
    if (toAppError(error).code === 'RoomNotFound') {
      await this.ports.audio.leaveVoiceSession().catch(() => undefined);
      if (!isCurrent()) return;
      this.ports.launch.stop();
      this.scope.disconnect();
      this.ports.notify('roomClosed', 'warning');
    } else {
      this.ports.launch.stop();
      this.markReconnecting();
    }
  }

  private async synchronize(
    snapshot: RoomStateDto,
    epoch: number,
  ): Promise<void> {
    const before = this.scope.getRoom();
    if (!before || !this.current(epoch, snapshot)) return;
    try {
      if (!hasCurrentParticipant(snapshot)) {
        await this.ports.audio.leaveVoiceSession().catch(() => undefined);
        if (!this.current(epoch, snapshot)) return;
        this.ports.launch.stop();
        this.scope.disconnect();
        this.ports.notify('removedFromRoom', 'warning');
        return;
      }
      const after = { ...snapshot, connectionStatus: 'connected' as const };
      await this.ports.voice.synchronize(before, after, () =>
        this.current(epoch, snapshot),
      );
      if (!this.current(epoch, snapshot)) return;
      this.ports.launch.recordPlaybackTransition(before, after);
      const change = diffParticipants(before, after);
      for (const person of change.joined)
        if (!person.self)
          this.ports.notify('participantJoined', 'info', { name: person.name });
      for (const person of change.left)
        this.ports.notify('participantLeft', 'info', { name: person.name });
      roomChimeKinds({
        joined: change.joined.length,
        left: change.left.length,
      }).forEach(this.ports.chime);
      if (
        !this.scope.setSnapshot(
          preserveLocalRoomTransfer(this.scope.getRoom() ?? before, after),
        )
      )
        return;
      await this.reconcileProject(after, epoch);
    } catch (error) {
      await this.onError(error, () => this.current(epoch, snapshot));
    }
  }

  private async reconcileProject(
    snapshot: RoomStateDto,
    epoch: number,
  ): Promise<void> {
    if (!this.pythonReady || !this.current(epoch, snapshot)) return;
    if (!snapshot.songId || snapshot.revision === undefined) {
      this.ports.launch.observe(snapshot, []);
      return;
    }
    const library = await this.ports.python.listSongs();
    if (!this.current(epoch, snapshot)) return;
    this.ports.launch.observe(snapshot, library);
    await this.ports.project.reconcileReadiness(snapshot, library);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    ++this.selectionEpoch;
  }
}
