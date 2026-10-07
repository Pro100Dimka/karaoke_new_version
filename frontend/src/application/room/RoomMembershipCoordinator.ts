import type { AudioServiceClient, DesktopClient, RoomClient } from "../../contracts/clients";
import type { RoomStateDto } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";

type MembershipPort = Pick<RoomClient, "transferHost" | "removeParticipant" | "startSyncCheck">;
type VoicePort = Pick<AudioServiceClient, "removeRemoteParticipant">;
type ClipboardPort = Pick<DesktopClient, "copyText">;

/** Keeps host operations and local voice cleanup within one participation generation. */
export class RoomMembershipCoordinator {
  constructor(private readonly scope: RoomSessionScope,
    private readonly room: MembershipPort, private readonly voice: VoicePort,
    private readonly clipboard: ClipboardPort) {}

  copyInvite(): Promise<void> {
    return this.scope.isCurrent() ? this.clipboard.copyText(this.scope.code) : Promise.resolve();
  }

  private async commit(response: Promise<RoomStateDto>): Promise<RoomStateDto | undefined> {
    const selected = this.scope.getRoom();
    const snapshot = await response;
    const latest = this.scope.getRoom();
    if (latest?.songId !== selected?.songId || latest?.revision !== selected?.revision)
      return undefined;
    return this.scope.setSnapshot(snapshot) ? snapshot : undefined;
  }

  transferHost(participantId: string): Promise<RoomStateDto | undefined> {
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    return this.commit(this.room.transferHost(this.scope.code, participantId));
  }

  async removeParticipant(participantId: string): Promise<RoomStateDto | undefined> {
    const selected = this.scope.getRoom();
    if (!selected) return undefined;
    const snapshot = await this.room.removeParticipant(this.scope.code, participantId);
    if (!this.scope.isCurrent()) return undefined;
    await this.voice.removeRemoteParticipant(participantId).catch(() => undefined);
    const latest = this.scope.getRoom();
    return !!latest && latest.songId === selected.songId && latest.revision === selected.revision &&
      this.scope.setSnapshot(snapshot) ? snapshot : undefined;
  }

  checkTiming(): Promise<RoomStateDto | undefined> {
    if (!this.scope.isCurrent()) return Promise.resolve(undefined);
    return this.commit(this.room.startSyncCheck(this.scope.code));
  }
}
