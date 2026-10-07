import type { RoomClient, RoomCommand, RoomSharedState } from "../../contracts/clients";
import type { RoomStateDto } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";

type PlaybackPort = Pick<RoomClient, "roomControl" | "clearRoomSong" |
  "updateSharedState" | "setRoomReadiness">;

/** Sends room playback intents in one participation generation. The server owns their timing. */
export class RoomPlaybackCoordinator {
  private starting?: Promise<RoomStateDto | undefined>;
  private prepared?: { key: string; state: "sending" | "ready";
    promise: Promise<void> };

  constructor(private readonly scope: RoomSessionScope, private readonly room: PlaybackPort) {}

  private async commit(operation: Promise<RoomStateDto>,
    selected?: Pick<RoomStateDto, "songId" | "revision">): Promise<RoomStateDto | undefined> {
    const snapshot = await operation;
    const current = this.scope.getRoom();
    if (!current || (selected &&
      (current.songId !== selected.songId || current.revision !== selected.revision)))
      return undefined;
    return this.scope.setSnapshot(snapshot) ? snapshot : undefined;
  }

  start(): Promise<RoomStateDto | undefined> {
    if (this.starting) return this.starting;
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    const starting = this.commit(this.room.roomControl(this.scope.code, "Start"),
      this.scope.getRoom() ?? undefined);
    this.starting = starting;
    void starting.then(
      () => { if (this.starting === starting) this.starting = undefined; },
      () => { if (this.starting === starting) this.starting = undefined; },
    );
    return starting;
  }

  control(command: Exclude<RoomCommand, "Start">, positionSeconds?: number): Promise<RoomStateDto | undefined> {
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    return this.commit(this.room.roomControl(this.scope.code, command, positionSeconds),
      this.scope.getRoom() ?? undefined);
  }

  clearSong(): Promise<RoomStateDto | undefined> {
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    return this.commit(this.room.clearRoomSong(this.scope.code),
      this.scope.getRoom() ?? undefined);
  }

  updateSharedState(state: RoomSharedState): Promise<RoomStateDto | undefined> {
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    return this.commit(this.room.updateSharedState(this.scope.code, state));
  }

  reportReady(songId: string, revision: number): Promise<void> {
    const key = `${songId}:${revision}`;
    if (this.prepared?.key === key) return this.prepared.promise;
    const current = this.scope.getRoom();
    if (current?.songId !== songId || current.revision !== revision)
      return Promise.resolve();
    const reporting = {
      key, state: "sending" as "sending" | "ready", promise: Promise.resolve(),
    };
    this.prepared = reporting;
    reporting.promise = this.room.setRoomReadiness(this.scope.code, "Ready", 100)
      .then((snapshot) => {
        if (this.prepared !== reporting) return;
        const latest = this.scope.getRoom();
        if (latest?.songId !== songId || latest.revision !== revision) {
          this.prepared = undefined;
          return;
        }
        this.scope.setSnapshot(snapshot);
        reporting.state = "ready";
      }).catch((error) => {
        if (this.prepared === reporting) this.prepared = undefined;
        throw error;
      });
    return reporting.promise;
  }
}
