import type { RoomClient, RoomSharedState } from "../../contracts/clients";
import type { RoomStateDto } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";

type LibraryPort = Pick<RoomClient, "selectRoomSong" | "setCollaborativeControl" |
  "updateSharedState">;

/** Applies library intents only to the room generation that initiated them. */
export class RoomLibraryCoordinator {
  private selectionEpoch = 0;
  constructor(private readonly scope: RoomSessionScope, private readonly room: LibraryPort) {}

  private async commit(response: Promise<RoomStateDto>, current = () => true,
    selected = this.scope.getRoom()): Promise<RoomStateDto | undefined> {
    const snapshot = await response;
    const latest = this.scope.getRoom();
    return current() && latest?.songId === selected?.songId &&
      latest?.revision === selected?.revision && this.scope.setSnapshot(snapshot)
      ? snapshot : undefined;
  }

  selectSong(songId: string, revision: number): Promise<RoomStateDto | undefined> {
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    const epoch = ++this.selectionEpoch;
    return this.commit(this.room.selectRoomSong(this.scope.code, songId, revision),
      () => epoch === this.selectionEpoch);
  }

  setCollaborativeControl(enabled: boolean): Promise<RoomStateDto | undefined> {
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    return this.commit(this.room.setCollaborativeControl(this.scope.code, enabled));
  }

  publishSharedState(state: RoomSharedState): Promise<RoomStateDto | undefined> {
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    return this.commit(this.room.updateSharedState(this.scope.code, state));
  }
}
