import {
  reportOperationFailure,
  clearOperationFailure,
} from '../../shared/errors';
import type { SongDto } from '../../contracts/models';
import type { RoomSessionScope } from './RoomSessionController';
import type { ProjectPorts } from './RoomProjectCoordinator';
import { roomProjectKey, selectedRoomProjectUpload } from './roomLibrary';
type Library =
  | { type: 'paused' }
  | {
      type: 'publishing';
      timer: ReturnType<typeof setInterval>;
      lastKey: string;
      uploaded: Set<string>;
      uploadId?: string;
      songs?: readonly SongDto[];
      readAt: number;
      revision: number;
      unsubscribe?: () => void;
    };
export class RoomLibraryPublisher {
  constructor(
    private readonly scope: RoomSessionScope,
    private readonly ports: Pick<
      ProjectPorts,
      'room' | 'python' | 'desktop' | 'participantId'
    >,
  ) {}
  private library: Library = { type: 'paused' };
  private publishing?: Promise<void>;
  setPythonReady(ready: boolean): void {
    if (!ready || !this.scope.isCurrent()) {
      const previous = this.library;
      this.library = { type: 'paused' };
      if (previous.type === 'publishing') {
        clearInterval(previous.timer);
        previous.unsubscribe?.();
        if (previous.uploadId)
          void this.ports.desktop
            .cancelRoomProjectTransfer(previous.uploadId)
            .catch(() => undefined);
      }
      return;
    }
    if (this.library.type === 'publishing') return;
    const running: Extract<Library, { type: 'publishing' }> = {
      type: 'publishing',
      lastKey: '',
      uploaded: new Set(),
      readAt: 0,
      revision: 0,
      timer: setInterval(() => void this.publishLibrary(), 1000),
    };
    this.library = running;
    running.unsubscribe = this.ports.python.onLibraryChange?.(() => {
      running.revision++;
      running.songs = undefined;
      void this.publishLibrary();
    });
    void this.publishLibrary();
  }
  private publishLibrary(): Promise<void> {
    if (this.publishing) return this.publishing;
    const library = this.library;
    if (library.type !== 'publishing' || !this.scope.isCurrent())
      return Promise.resolve();
    const revision = library.revision;
    const publishing = (async () => {
      try {
        const refreshMilliseconds = this.ports.python.onLibraryChange
          ? 30_000
          : 1000;
        if (
          !library.songs ||
          Date.now() - library.readAt >= refreshMilliseconds
        ) {
          const songs = await this.ports.python.listSongs();
          if (
            this.library !== library ||
            !this.scope.isCurrent() ||
            revision !== library.revision
          )
            return;
          library.songs = songs.filter((song) => song.status === 'ready');
          library.readAt = Date.now();
        }
        const songs = library.songs;
        if (this.library !== library || !this.scope.isCurrent()) return;
        const key = songs
          .map((song) =>
            JSON.stringify([
              song.id,
              song.activeRevision,
              song.title,
              song.artist,
              song.album,
              song.genre,
              song.durationSeconds,
              song.sourceHash,
              song.projectHash,
            ]),
          )
          .sort()
          .join('|');
        if (key !== library.lastKey) {
          const updated = await this.ports.room.publishLibrary(
            this.scope.code,
            songs,
          );
          if (this.library !== library || !this.scope.isCurrent()) return;
          library.lastKey = key;
          this.scope.setSnapshot(updated);
        }
        const selected = this.scope.getRoom();
        const owner = selected?.sharedSongs?.find(
          (song) =>
            song.songId === selected.songId &&
            song.revision === selected.revision,
        )?.ownerParticipantId;
        const song = selectedRoomProjectUpload(
          this.scope.code,
          songs,
          library.uploaded,
          selected?.songId,
          selected?.revision,
          owner,
          this.ports.participantId,
        );
        if (!song) return;
        const needsArchive = selected?.participants.some(
          (person) =>
            person.connected &&
            person.id !== this.ports.participantId &&
            !['preparing', 'audio', 'ready'].includes(person.readiness) &&
            !selected.sharedSongs?.some(
              (item) =>
                item.ownerParticipantId === person.id &&
                song.projectHash &&
                item.projectHash === song.projectHash,
            ),
        );
        if (!needsArchive) return;
        const transferId = crypto.randomUUID();
        try {
          const path = await this.ports.python.exportProject(
            song.id,
            song.activeRevision,
          );
          if (this.library !== library || !this.scope.isCurrent()) return;
          library.uploadId = transferId;
          await this.ports.desktop.uploadRoomProject({
            roomId: this.scope.code,
            participantId: this.ports.participantId,
            songId: song.id,
            revision: song.activeRevision,
            path,
            transferId,
          });
          if (this.library !== library || !this.scope.isCurrent()) return;
          library.uploaded.add(roomProjectKey(this.scope.code, song));
        } catch (error) {
          if (this.library !== library || !this.scope.isCurrent()) return;
          console.error('Room project export/upload failed', error);
          const failed = this.scope.getRoom();
          if (failed?.transferId === transferId)
            this.scope.setSnapshot({ ...failed, transferError: true });
        } finally {
          library.uploadId = undefined;
        }
        clearOperationFailure('errors.roomLibrary');
      } catch (error) {
        if (this.library === library && this.scope.isCurrent())
          reportOperationFailure('errors.roomLibrary', error);
      }
    })();
    this.publishing = publishing;
    void publishing.finally(() => {
      if (this.publishing === publishing) this.publishing = undefined;
      if (
        this.library === library &&
        this.scope.isCurrent() &&
        library.revision !== revision
      )
        void this.publishLibrary();
    });
    return publishing;
  }
}
