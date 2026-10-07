import type { RoomSessionController } from "../room/RoomSessionController";

type InvitationPort = {
  acceptInvite(id: string): Promise<{ roomId: string }>;
  declineInvite(id: string): Promise<void>;
  clearRequestedRoom(roomId: string): void;
  isRequestedRoom(roomId: string): boolean;
  approveJoinRequest(accountId: string, roomId: string): Promise<void>;
  requestRoomJoin(accountId: string, roomId: string): Promise<void>;
  invite(accountId: string, roomId: string): Promise<void>;
  setPresence(value: { displayName: string; participantId: string; roomId: string }): Promise<void>;
};
type RoomPort = Pick<RoomSessionController, "getRoom" | "leave" | "join">;

/** Coordinates invitations with the one local room owner. */
export class RoomInvitationCoordinator {
  private readonly invitations = new Map<string,
    { type: "accepting"; promise: Promise<void> } | { type: "accepted" }>();

  constructor(private readonly social: InvitationPort,
    private readonly room: RoomPort, private readonly participantId = "") {}

  isRequestedRoom(roomId: string): boolean { return this.social.isRequestedRoom(roomId); }
  isHandled(inviteId: string): boolean { return this.invitations.has(inviteId); }
  prune(activeInviteIds: readonly string[]): void {
    const active = new Set(activeInviteIds);
    for (const id of this.invitations.keys())
      if (!active.has(id)) this.invitations.delete(id);
  }
  decline(id: string): Promise<void> { return this.social.declineInvite(id); }
  approve(accountId: string, roomId: string): Promise<void> {
    return this.social.approveJoinRequest(accountId, roomId);
  }
  requestJoin(accountId: string, roomId: string): Promise<void> {
    return this.social.requestRoomJoin(accountId, roomId);
  }
  invite(accountId: string, roomId: string): Promise<void> {
    return this.social.invite(accountId, roomId);
  }

  accept(inviteId: string, displayName: string): Promise<void> {
    const existing = this.invitations.get(inviteId);
    if (existing?.type === "accepted") return Promise.resolve();
    if (existing?.type === "accepting") return existing.promise;
    const operation = (async () => {
      const { roomId } = await this.social.acceptInvite(inviteId);
      if (this.room.getRoom()) await this.room.leave();
      await this.room.join(displayName, roomId);
      this.social.clearRequestedRoom(roomId);
      this.invitations.set(inviteId, { type: "accepted" });
    })();
    this.invitations.set(inviteId, { type: "accepting", promise: operation });
    void operation.catch(() => {
      const current = this.invitations.get(inviteId);
      if (current?.type === "accepting" && current.promise === operation)
        this.invitations.delete(inviteId);
    });
    return operation;
  }

  async createTogether(accountId: string, displayName: string): Promise<void> {
    const created = await this.room.join(displayName);
    await this.social.setPresence({ displayName,
      participantId: this.participantId, roomId: created.code });
    await this.social.invite(accountId, created.code);
  }
}
