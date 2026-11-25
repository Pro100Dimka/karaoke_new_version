import {
  reportOperationFailure,
  clearOperationFailure,
} from '../../shared/errors';
import type {
  DesktopClient,
  ProjectImportDecision,
  PythonClient,
  RoomClient,
} from '../../contracts/clients';
import type { RoomStateDto, SongDto } from '../../contracts/models';
import {
  roomSnapshotIsOlder,
  type RoomSessionScope,
} from './RoomSessionController';
import { createLatestSnapshotQueue } from './latestSnapshotQueue';
import { RoomLibraryPublisher } from './RoomLibraryPublisher';
import { localReadiness, localRoomSong } from './roomModel';
import {
  downloadAvailableRoomProject,
  isProjectConflict,
  preserveLocalRoomTransfer,
  roomTransferFailure,
} from './roomProjectDownload';

export type ProjectPorts = {
  room: Pick<RoomClient, 'setRoomReadiness' | 'publishLibrary'>;
  python: Pick<
    PythonClient,
    'importProject' | 'listSongs' | 'exportProject' | 'onLibraryChange'
  >;
  desktop: Pick<
    DesktopClient,
    | 'downloadRoomProject'
    | 'cancelRoomProjectTransfer'
    | 'releaseRoomProjectDownload'
    | 'uploadRoomProject'
    | 'onRoomProjectTransferProgress'
  >;
  copies: {
    get(songId?: string, revision?: number): string | undefined;
    remember(songId: string, revision: number, localId: string): void;
  };
  participantId: string;
  onFailure(conflict: boolean, error: unknown): void;
};

type Transfer =
  | { type: 'idle' }
  | {
      type: 'preparing';
      songId: string;
      revision: number;
      selectionId: number;
      id: string;
      abort: AbortController;
      promise?: Promise<readonly SongDto[] | undefined>;
    }
  | { type: 'failed'; songId: string; revision: number }
  | { type: 'cancelled'; selectionId: number; publication: Promise<void> };

/** Owns one room's project download/import transaction and its compensating cleanup. */
export class RoomProjectCoordinator {
  private readonly library: RoomLibraryPublisher;
  private transfer: Transfer = { type: 'idle' };
  private unsubscribeProgress?: () => void;
  private approvedReplacement?: { songId: string; revision: number };

  constructor(
    private readonly scope: RoomSessionScope,
    private readonly ports: ProjectPorts,
  ) {
    this.library = new RoomLibraryPublisher(scope, ports);
  }

  getState = (): Transfer['type'] => this.transfer.type;

  importDecision(songId: string, revision: number): ProjectImportDecision {
    return this.approvedReplacement?.songId === songId &&
      this.approvedReplacement.revision === revision
      ? 'AcceptDivergent'
      : 'AcceptOlder';
  }

  async retry(): Promise<void> {
    const selected = this.scope.getRoom();
    if (!selected) return;
    if (this.transfer.type === 'cancelled') {
      await this.transfer.publication;
      if (this.scope.getRoom()?.selectionId !== selected.selectionId) return;
      this.transfer = { type: 'idle' };
    }
    const snapshot = await this.ports.room.setRoomReadiness(
      this.scope.code,
      'MissingSong',
      selected.selectionId ?? 0,
    );
    const current = this.scope.getRoom();
    if (
      current &&
      current.selectionId === selected.selectionId &&
      current.songId === selected.songId &&
      current.revision === selected.revision
    )
      this.scope.setSnapshot(snapshot);
  }

  replaceProject(): Promise<void> {
    const selected = this.scope.getRoom();
    if (selected?.songId && selected.revision !== undefined)
      this.approvedReplacement = {
        songId: selected.songId,
        revision: selected.revision,
      };
    return this.retry();
  }

  cancelTransfer(): void {
    const selected = this.scope.getRoom();
    if (!selected || this.transfer.type !== 'preparing') return;
    const transferId = selected.transferId;
    this.cancel();
    const cancelled: Extract<Transfer, { type: 'cancelled' }> = {
      type: 'cancelled',
      selectionId: selected.selectionId ?? 0,
      publication: Promise.resolve(),
    };
    this.transfer = cancelled;
    this.scope.setSnapshot(roomTransferFailure(selected, false));
    cancelled.publication = this.ports.room
      .setRoomReadiness(this.scope.code, 'Failed', cancelled.selectionId)
      .then((snapshot) => {
        if (
          this.transfer === cancelled &&
          this.scope.isCurrent() &&
          (this.scope.getRoom()?.selectionId ?? 0) === cancelled.selectionId
        )
          this.scope.setSnapshot(roomTransferFailure(snapshot, false));
      })
      .catch((error) => {
        if (this.transfer === cancelled && this.scope.isCurrent())
          this.ports.onFailure(false, error);
      });
    if (transferId)
      void this.ports.desktop
        .cancelRoomProjectTransfer(transferId)
        .catch(() => undefined);
  }

  start(): void {
    if (this.unsubscribeProgress) return;
    let postedProgress = '';
    const queue = createLatestSnapshotQueue<RoomProjectTransferProgress>(
      async (progress) => {
        const current = this.scope.getRoom();
        if (
          !current ||
          current.transferId !== progress.transferId ||
          (current.transferProgress ?? 0) >= 70
        )
          return;
        const ratio =
          progress.totalBytes > 0
            ? Math.min(1, progress.transferredBytes / progress.totalBytes)
            : 0;
        const { start, span } = {
          upload: { start: 10, span: 25 },
          download: { start: 35, span: 30 },
        }[progress.direction];
        const transferProgress = Math.max(
          current.transferProgress ?? 0,
          start + Math.round(ratio * span),
        );
        this.scope.setSnapshot({
          ...current,
          transferProgress,
          transferPhase: progress.direction,
          transferBytes: progress.transferredBytes,
          transferTotalBytes: progress.totalBytes,
        });
        const posted = `${progress.transferId}:${progress.direction}:${transferProgress}`;
        if (posted === postedProgress) return;
        postedProgress = posted;
        try {
          const snapshot = await this.ports.room.setRoomReadiness(
            this.scope.code,
            'Downloading',
            current.selectionId ?? 0,
            transferProgress,
          );
          const latest = this.scope.getRoom();
          if (
            !latest ||
            latest.selectionId !== current.selectionId ||
            latest.transferId !== progress.transferId ||
            (latest.transferProgress ?? 0) >= 70
          )
            return;
          this.scope.setSnapshot({
            ...preserveLocalRoomTransfer(latest, snapshot),
            transferProgress: Math.max(
              latest.transferProgress ?? 0,
              transferProgress,
            ),
            transferId: progress.transferId,
            transferBytes: latest.transferBytes,
            transferTotalBytes: latest.transferTotalBytes,
            transferPhase: latest.transferPhase,
          });
          clearOperationFailure('errors.roomProgress');
        } catch (error) {
          if (this.scope.isCurrent())
            reportOperationFailure('errors.roomProgress', error);
        }
      },
    );
    this.unsubscribeProgress = this.ports.desktop.onRoomProjectTransferProgress(
      (progress) => {
        void queue.push(progress);
      },
    );
  }
  setPythonReady(ready: boolean): void {
    this.library.setPythonReady(ready);
  }

  stop(): void {
    this.setPythonReady(false);
    this.unsubscribeProgress?.();
    this.unsubscribeProgress = undefined;
    this.cancel();
    this.transfer = { type: 'idle' };
    this.approvedReplacement = undefined;
  }

  async reconcileReadiness(
    snapshot: RoomStateDto,
    library: readonly SongDto[],
  ): Promise<void> {
    if (
      !snapshot.songId ||
      snapshot.revision === undefined ||
      !this.scope.isCurrent()
    )
      return;
    const self = snapshot.participants.find((person) => person.self);
    if (!self) return;
    const wanted = localReadiness(
      snapshot,
      library,
      this.ports.copies.get(snapshot.songId, snapshot.revision),
    );
    const nextReadiness = (
      {
        Ready: ['missing', 'failed', 'disconnected'].includes(self.readiness)
          ? 'Preparing'
          : undefined,
        MissingSong: ![
          'missing',
          'downloading',
          'verifying',
          'failed',
        ].includes(self.readiness)
          ? 'MissingSong'
          : undefined,
      } as const
    )[wanted];
    if (!nextReadiness) return;
    const updated = await this.ports.room.setRoomReadiness(
      this.scope.code,
      nextReadiness,
      snapshot.selectionId ?? 0,
    );
    const current = this.scope.getRoom();
    if (
      current?.songId === snapshot.songId &&
      current.selectionId === snapshot.selectionId &&
      current.revision === snapshot.revision
    )
      this.scope.setSnapshot(updated);
  }

  cancel(): void {
    const active = this.transfer;
    if (active.type === 'cancelled') return;
    this.transfer = { type: 'idle' };
    if (active.type !== 'preparing') return;
    active.abort.abort();
  }

  prepare(
    songId: string,
    revision: number,
  ): Promise<readonly SongDto[] | undefined> {
    const previous = this.transfer;
    const selectionId = this.scope.getRoom()?.selectionId ?? 0;
    if (previous.type === 'cancelled' && previous.selectionId === selectionId)
      return Promise.resolve(undefined);
    if (previous.type === 'preparing') {
      if (
        previous.songId === songId &&
        previous.revision === revision &&
        previous.selectionId === selectionId
      )
        return previous.promise ?? Promise.resolve(undefined);
      this.cancel();
    }
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    const active: Extract<Transfer, { type: 'preparing' }> = {
      type: 'preparing',
      songId,
      revision,
      selectionId,
      id: crypto.randomUUID(),
      abort: new AbortController(),
    };
    this.transfer = active;
    const isCurrent = () =>
      this.transfer === active &&
      !active.abort.signal.aborted &&
      (this.scope.getRoom()?.selectionId ?? 0) === selectionId &&
      this.scope.isCurrent();
    const progress = (
      value: number,
      details?: Pick<
        RoomStateDto,
        | 'transferId'
        | 'transferBytes'
        | 'transferTotalBytes'
        | 'transferError'
        | 'transferPhase'
      >,
    ) => {
      const current = this.scope.getRoom();
      if (current && isCurrent())
        this.scope.setSnapshot({
          ...current,
          transferProgress: value,
          ...details,
        });
    };
    active.promise = (async () => {
      let archive: string | undefined;
      try {
        const library = await this.ports.python.listSongs();
        if (!isCurrent()) return;
        const selected = this.scope.getRoom();
        if (
          selected?.songId === songId &&
          selected.revision === revision &&
          localRoomSong(
            selected,
            library,
            this.ports.copies.get(songId, revision),
          )
        ) {
          this.transfer = { type: 'idle' };
          return library;
        }
        progress(10, {
          transferId: active.id,
          transferBytes: 0,
          transferTotalBytes: 0,
          transferPhase: undefined,
          transferError: false,
        });
        const downloading = await this.ports.room.setRoomReadiness(
          this.scope.code,
          'Downloading',
          selectionId,
          10,
        );
        if (!isCurrent()) return;
        this.scope.setSnapshot({
          ...downloading,
          transferProgress: 10,
          transferId: active.id,
          transferBytes: 0,
          transferTotalBytes: 0,
          transferPhase: undefined,
          transferError: false,
        });
        archive = await downloadAvailableRoomProject(
          async (request) => {
            const file = await this.ports.desktop.downloadRoomProject(request);
            if (!isCurrent()) {
              await this.ports.desktop.releaseRoomProjectDownload(file);
              throw new DOMException('Room transfer cancelled', 'AbortError');
            }
            return file;
          },
          (milliseconds) =>
            new Promise((resolve) => setTimeout(resolve, milliseconds)),
          {
            roomId: this.scope.code,
            participantId: this.ports.participantId,
            songId,
            revision,
            transferId: active.id,
          },
          {
            signal: active.abort.signal,
            hasProgress: () => (this.scope.getRoom()?.transferBytes ?? 0) > 0,
            transferredBytes: () => this.scope.getRoom()?.transferBytes ?? 0,
            cancel: () =>
              void this.ports.desktop
                .cancelRoomProjectTransfer(active.id)
                .catch(() => undefined),
          },
        );
        if (!isCurrent()) return;
        progress(70);
        const importing = await this.ports.room.setRoomReadiness(
          this.scope.code,
          'Importing',
          selectionId,
          70,
        );
        if (!isCurrent()) return;
        this.scope.setSnapshot(
          preserveLocalRoomTransfer(this.scope.getRoom() ?? importing, {
            ...importing,
            transferProgress: 70,
          }),
        );
        const imported = await this.ports.python.importProject(
          archive,
          this.importDecision(songId, revision),
        );
        if (!isCurrent()) return;
        this.ports.copies.remember(songId, revision, imported.id);
        progress(95);
        const preparing = await this.ports.room.setRoomReadiness(
          this.scope.code,
          'Preparing',
          selectionId,
          95,
        );
        if (!isCurrent()) return;
        this.scope.setSnapshot(
          preserveLocalRoomTransfer(this.scope.getRoom() ?? preparing, {
            ...preparing,
            transferProgress: 95,
          }),
        );
        const refreshedLibrary = await this.ports.python.listSongs();
        if (!isCurrent()) return;
        const selectedProject = this.scope.getRoom();
        if (
          selectedProject?.sharedSongs?.some(
            (song) =>
              song.songId === songId &&
              song.revision === revision &&
              song.projectHash,
          ) &&
          !localRoomSong(selectedProject, refreshedLibrary, imported.id)
        )
          throw new Error(
            'Downloaded project does not match the selected room project',
          );
        this.transfer = { type: 'idle' };
        return refreshedLibrary;
      } catch (error) {
        if (!isCurrent()) return;
        const failed = await this.ports.room
          .setRoomReadiness(this.scope.code, 'Failed', selectionId)
          .catch(() => this.scope.getRoom());
        if (!isCurrent()) return;
        const conflict = isProjectConflict(error);
        if (failed) {
          const current = this.scope.getRoom();
          const snapshot =
            current && roomSnapshotIsOlder(failed, current) ? current : failed;
          this.scope.setSnapshot(roomTransferFailure(snapshot, conflict));
        }
        this.transfer = { type: 'failed', songId, revision };
        this.ports.onFailure(conflict, error);
      } finally {
        if (archive)
          await this.ports.desktop
            .releaseRoomProjectDownload(archive)
            .catch((error) =>
              console.error('Room archive cleanup failed', error),
            );
      }
    })();
    return active.promise;
  }
}
