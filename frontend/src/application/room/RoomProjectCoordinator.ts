import type { DesktopClient, ProjectImportDecision, PythonClient, RoomClient } from "../../contracts/clients";
import type { RoomStateDto, SongDto } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";
import { createLatestSnapshotQueue } from "./latestSnapshotQueue";
import { roomProjectKey, selectedRoomProjectUpload } from "./roomLibrary";
import { localReadiness } from "./roomModel";
import {
  downloadAvailableRoomProject,
  isProjectConflict,
  preserveLocalRoomTransfer,
  roomTransferFailure,
} from "./roomProjectDownload";

type ProjectPorts = {
  room: Pick<RoomClient, "setRoomReadiness" | "publishLibrary">;
  python: Pick<PythonClient, "importProject" | "listSongs" | "exportProject">;
  desktop: Pick<DesktopClient, "downloadRoomProject" | "cancelRoomProjectTransfer" |
    "releaseRoomProjectDownload" | "uploadRoomProject" | "onRoomProjectTransferProgress">;
  copies: { get(songId?: string, revision?: number): string | undefined;
    remember(songId: string, revision: number, localId: string): void };
  participantId: string;
  onFailure(conflict: boolean, error: unknown): void;
};

type Transfer =
  | { type: "idle" }
  | { type: "preparing"; songId: string; revision: number; id: string;
      abort: AbortController; promise?: Promise<readonly SongDto[] | undefined> }
  | { type: "failed"; songId: string; revision: number };

type Library =
  | { type: "paused" }
  | { type: "publishing"; timer: ReturnType<typeof setInterval>;
      lastKey: string; uploaded: Set<string>; uploadId?: string };

/** Owns one room's project download/import transaction and its compensating cleanup. */
export class RoomProjectCoordinator {
  private transfer: Transfer = { type: "idle" };
  private library: Library = { type: "paused" };
  private publishing?: Promise<void>;
  private unsubscribeProgress?: () => void;
  private approvedReplacement?: { songId: string; revision: number };

  constructor(
    private readonly scope: RoomSessionScope,
    private readonly ports: ProjectPorts,
  ) {}

  getState = (): Transfer["type"] => this.transfer.type;

  importDecision(songId: string, revision: number): ProjectImportDecision {
    return this.approvedReplacement?.songId === songId &&
      this.approvedReplacement.revision === revision ? "AcceptDivergent" : "AcceptOlder";
  }

  async selectedArtwork(): Promise<{ songId: string; title: string; url: string } | undefined> {
    const selected = this.scope.getRoom();
    if (!selected?.songId) return undefined;
    const songs = await this.ports.python.listSongs();
    const current = this.scope.getRoom();
    if (current?.songId !== selected.songId || current.revision !== selected.revision) return undefined;
    const song = songs.find((item) => item.id === selected.songId && item.artworkUrl);
    return song?.artworkUrl ? { songId: song.id, title: song.title, url: song.artworkUrl } : undefined;
  }

  async retry(): Promise<void> {
    const selected = this.scope.getRoom();
    if (!selected) return;
    const snapshot = await this.ports.room.setRoomReadiness(this.scope.code, "MissingSong");
    const current = this.scope.getRoom();
    if (current && current.songId === selected.songId && current.revision === selected.revision)
      this.scope.setSnapshot(snapshot);
  }

  replaceProject(): Promise<void> {
    const selected = this.scope.getRoom();
    if (selected?.songId && selected.revision !== undefined)
      this.approvedReplacement = { songId: selected.songId, revision: selected.revision };
    return this.retry();
  }

  cancelTransfer(): void {
    const transferId = this.scope.getRoom()?.transferId;
    this.cancel();
    if (transferId)
      void this.ports.desktop.cancelRoomProjectTransfer(transferId).catch(() => undefined);
  }

  start(): void {
    if (this.unsubscribeProgress) return;
    let postedProgress = "";
    const queue = createLatestSnapshotQueue<RoomProjectTransferProgress>(async (progress) => {
      const current = this.scope.getRoom();
      if (!current || current.transferId !== progress.transferId ||
          progress.direction !== "download" || (current.transferProgress ?? 0) >= 70) return;
      const ratio = progress.totalBytes > 0
        ? Math.min(1, progress.transferredBytes / progress.totalBytes) : 0;
      const transferProgress = 10 + Math.round(ratio * 55);
      const posted = `${progress.transferId}:${transferProgress}`;
      if (posted === postedProgress) return;
      postedProgress = posted;
      try {
        const snapshot = await this.ports.room.setRoomReadiness(
          this.scope.code, "Downloading", transferProgress,
        );
        const latest = this.scope.getRoom();
        if (!latest || latest.transferId !== progress.transferId ||
            (latest.transferProgress ?? 0) >= 70) return;
        this.scope.setSnapshot({ ...snapshot, transferProgress,
          transferId: progress.transferId,
          transferBytes: progress.transferredBytes,
          transferTotalBytes: progress.totalBytes });
      } catch {
        // The next byte sample retries without interrupting the transfer.
      }
    });
    this.unsubscribeProgress = this.ports.desktop.onRoomProjectTransferProgress(
      (progress) => { void queue.push(progress); },
    );
  }

  setPythonReady(ready: boolean): void {
    if (!ready || !this.scope.isCurrent()) {
      const previous = this.library;
      this.library = { type: "paused" };
      if (previous.type === "publishing") {
        clearInterval(previous.timer);
        if (previous.uploadId)
          void this.ports.desktop.cancelRoomProjectTransfer(previous.uploadId).catch(() => undefined);
      }
      return;
    }
    if (this.library.type === "publishing") return;
    const running: Extract<Library, { type: "publishing" }> = {
      type: "publishing", lastKey: "", uploaded: new Set(),
      timer: setInterval(() => void this.publishLibrary(), 1000),
    };
    this.library = running;
    void this.publishLibrary();
  }

  private publishLibrary(): Promise<void> {
    if (this.publishing) return this.publishing;
    const library = this.library;
    if (library.type !== "publishing" || !this.scope.isCurrent()) return Promise.resolve();
    const publishing = (async () => {
      try {
        const songs = (await this.ports.python.listSongs()).filter((song) => song.status === "ready");
        if (this.library !== library || !this.scope.isCurrent()) return;
        const key = songs.map((song) => `${song.id}:${song.activeRevision}`).sort().join("|");
        if (key !== library.lastKey) {
          const updated = await this.ports.room.publishLibrary(this.scope.code, songs);
          if (this.library !== library || !this.scope.isCurrent()) return;
          library.lastKey = key;
          this.scope.setSnapshot(updated);
        }
        const selected = this.scope.getRoom();
        const owner = selected?.sharedSongs?.find((song) =>
          song.songId === selected.songId && song.revision === selected.revision,
        )?.ownerParticipantId;
        const song = selectedRoomProjectUpload(
          this.scope.code, songs, library.uploaded, selected?.songId,
          selected?.revision, owner, this.ports.participantId,
        );
        if (!song) return;
        const transferId = crypto.randomUUID();
        try {
          const path = await this.ports.python.exportProject(song.id, song.activeRevision);
          if (this.library !== library || !this.scope.isCurrent()) return;
          library.uploadId = transferId;
          await this.ports.desktop.uploadRoomProject({ roomId: this.scope.code,
            participantId: this.ports.participantId, songId: song.id,
            revision: song.activeRevision, path, transferId });
          if (this.library !== library || !this.scope.isCurrent()) return;
          library.uploaded.add(roomProjectKey(this.scope.code, song));
        } catch (error) {
          if (this.library !== library || !this.scope.isCurrent()) return;
          console.error("Room project export/upload failed", error);
          const failed = this.scope.getRoom();
          if (failed?.transferId === transferId)
            this.scope.setSnapshot({ ...failed, transferError: true });
        } finally {
          library.uploadId = undefined;
        }
      } catch {
        // The next interval retries while local library use remains available.
      }
    })();
    this.publishing = publishing;
    void publishing.finally(() => { if (this.publishing === publishing) this.publishing = undefined; });
    return publishing;
  }

  stop(): void {
    this.setPythonReady(false);
    this.unsubscribeProgress?.();
    this.unsubscribeProgress = undefined;
    this.cancel();
    this.approvedReplacement = undefined;
  }

  async reconcileReadiness(snapshot: RoomStateDto, library: readonly SongDto[]): Promise<void> {
    if (!snapshot.songId || snapshot.revision === undefined || !this.scope.isCurrent()) return;
    const self = snapshot.participants.find((person) => person.self);
    if (!self) return;
    const wanted = localReadiness(
      snapshot, library, this.ports.copies.get(snapshot.songId, snapshot.revision),
    );
    const nextReadiness = ({
      Ready: ["missing", "failed", "disconnected"].includes(self.readiness)
        ? "Preparing" : undefined,
      MissingSong: !["missing", "downloading", "verifying", "failed"].includes(self.readiness)
        ? "MissingSong" : undefined,
    } as const)[wanted];
    if (!nextReadiness) return;
    const updated = await this.ports.room.setRoomReadiness(this.scope.code, nextReadiness);
    const current = this.scope.getRoom();
    if (current?.songId === snapshot.songId && current.revision === snapshot.revision)
      this.scope.setSnapshot(updated);
  }

  cancel(): void {
    const active = this.transfer;
    this.transfer = { type: "idle" };
    if (active.type !== "preparing") return;
    active.abort.abort();
  }

  prepare(songId: string, revision: number): Promise<readonly SongDto[] | undefined> {
    const previous = this.transfer;
    if (previous.type === "preparing") {
      if (previous.songId === songId && previous.revision === revision)
        return previous.promise ?? Promise.resolve(undefined);
      this.cancel();
    }
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    const active: Extract<Transfer, { type: "preparing" }> = {
      type: "preparing", songId, revision, id: crypto.randomUUID(), abort: new AbortController(),
    };
    this.transfer = active;
    const isCurrent = () => this.transfer === active &&
      !active.abort.signal.aborted && this.scope.isCurrent();
    const progress = (
      value: number,
      details?: Pick<RoomStateDto, "transferId" | "transferBytes" | "transferTotalBytes" | "transferError">,
    ) => {
      const current = this.scope.getRoom();
      if (current && isCurrent())
        this.scope.setSnapshot({ ...current, transferProgress: value, ...details });
    };
    progress(10, {
      transferId: active.id, transferBytes: 0, transferTotalBytes: 0, transferError: false,
    });
    active.promise = (async () => {
      let archive: string | undefined;
      try {
        const downloading = await this.ports.room.setRoomReadiness(this.scope.code, "Downloading", 10);
        if (!isCurrent()) return;
        this.scope.setSnapshot({ ...downloading, transferProgress: 10,
          transferId: active.id, transferBytes: 0, transferTotalBytes: 0, transferError: false });
        archive = await downloadAvailableRoomProject(
          async (request) => {
            const file = await this.ports.desktop.downloadRoomProject(request);
            if (!isCurrent()) {
              await this.ports.desktop.releaseRoomProjectDownload(file);
              throw new DOMException("Room transfer cancelled", "AbortError");
            }
            return file;
          },
          (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
          { roomId: this.scope.code, participantId: this.ports.participantId,
            songId, revision, transferId: active.id },
          { signal: active.abort.signal,
            cancel: () => void this.ports.desktop.cancelRoomProjectTransfer(active.id).catch(() => undefined) },
        );
        if (!isCurrent()) return;
        progress(70);
        const importing = await this.ports.room.setRoomReadiness(this.scope.code, "Importing", 70);
        if (!isCurrent()) return;
        this.scope.setSnapshot(preserveLocalRoomTransfer(
          this.scope.getRoom() ?? importing, { ...importing, transferProgress: 70 },
        ));
        const imported = await this.ports.python.importProject(archive, this.importDecision(songId, revision));
        if (!isCurrent()) return;
        this.ports.copies.remember(songId, revision, imported.id);
        progress(95);
        const preparing = await this.ports.room.setRoomReadiness(this.scope.code, "Preparing", 95);
        if (!isCurrent()) return;
        this.scope.setSnapshot(preserveLocalRoomTransfer(
          this.scope.getRoom() ?? preparing, { ...preparing, transferProgress: 95 },
        ));
        const library = await this.ports.python.listSongs();
        if (!isCurrent()) return;
        this.transfer = { type: "idle" };
        return library;
      } catch (error) {
        if (!isCurrent()) return;
        const failed = await this.ports.room.setRoomReadiness(this.scope.code, "Failed")
          .catch(() => this.scope.getRoom());
        if (!isCurrent()) return;
        const conflict = isProjectConflict(error);
        if (failed) this.scope.setSnapshot(roomTransferFailure(failed, conflict));
        this.transfer = { type: "failed", songId, revision };
        this.ports.onFailure(conflict, error);
      } finally {
        if (archive)
          await this.ports.desktop.releaseRoomProjectDownload(archive)
            .catch((error) => console.error("Room archive cleanup failed", error));
      }
    })();
    return active.promise;
  }
}
