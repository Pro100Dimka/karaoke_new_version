import type { RoomSessionController } from '../room/RoomSessionController';
import type { SocialInvite } from '../../contracts/social';

type InvitationPort = {
  acceptInvite(id: string): Promise<{ roomId: string }>;
  declineInvite(id: string): Promise<void>;
  clearRequestedRoom(roomId: string): void;
  isRequestedRoom(roomId: string): boolean;
  approveJoinRequest(accountId: string, roomId: string): Promise<void>;
  requestRoomJoin(accountId: string, roomId: string): Promise<void>;
  invite(accountId: string, roomId: string): Promise<void>;
  setPresence(value: {
    displayName: string;
    participantId: string;
    roomId: string;
  }): Promise<void>;
};
type RoomPort = Pick<RoomSessionController, 'getRoom' | 'leave' | 'join'>;
type InvitationState =
  | { type: 'accepting'; promise: Promise<void>; invite?: SocialInvite }
  | { type: 'retry'; roomId: string; invite?: SocialInvite }
  | { type: 'accepted' };

/** Coordinates invitations with the one local room owner. */
export class RoomInvitationCoordinator {
  private readonly invitations = new Map<string, InvitationState>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private roomTransition: Promise<void> = Promise.resolve();

  constructor(
    private readonly social: InvitationPort,
    private readonly room: RoomPort,
    private readonly participantId = '',
  ) {}

  getSnapshot = (): number => this.version;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
  private queueRoomTransition(action: () => Promise<void>): Promise<void> {
    const operation = this.roomTransition.then(action);
    this.roomTransition = operation.catch(() => undefined);
    return operation;
  }
  /** Server acceptance removes the inbox entry before the local room join finishes. */
  availableInvites(incoming: readonly SocialInvite[]): SocialInvite[] {
    const invites = new Map(
      incoming.map((invite) => [invite.inviteId, invite]),
    );
    for (const [id, state] of this.invitations) {
      if (state.type === 'accepted') invites.delete(id);
      else if (state.invite && !invites.has(id)) invites.set(id, state.invite);
    }
    return [...invites.values()];
  }
  isRequestedRoom(roomId: string): boolean {
    return this.social.isRequestedRoom(roomId);
  }
  isHandled(inviteId: string): boolean {
    const state = this.invitations.get(inviteId);
    return state !== undefined && state.type !== 'retry';
  }
  canRetry(inviteId: string): boolean {
    return this.invitations.get(inviteId)?.type === 'retry';
  }
  prune(activeInviteIds: readonly string[]): void {
    const active = new Set(activeInviteIds);
    let removed = false;
    for (const [id, state] of this.invitations)
      if (!active.has(id) && state.type === 'accepted') {
        this.invitations.delete(id);
        removed = true;
      }
    if (removed) this.changed();
  }
  decline(id: string): Promise<void> {
    const state = this.invitations.get(id);
    if (state?.type === 'accepted') return Promise.resolve();
    if (state?.type === 'retry') {
      this.social.clearRequestedRoom(state.roomId);
      this.invitations.set(id, { type: 'accepted' });
      this.changed();
      return Promise.resolve();
    }
    return this.social.declineInvite(id);
  }
  approve(accountId: string, roomId: string): Promise<void> {
    return this.social.approveJoinRequest(accountId, roomId);
  }
  requestJoin(accountId: string, roomId: string): Promise<void> {
    return this.social.requestRoomJoin(accountId, roomId);
  }
  invite(accountId: string, roomId: string): Promise<void> {
    return this.social.invite(accountId, roomId);
  }

  accept(
    invitation: string | SocialInvite,
    displayName: string,
  ): Promise<void> {
    const inviteId =
      typeof invitation === 'string' ? invitation : invitation.inviteId;
    const existing = this.invitations.get(inviteId);
    if (existing?.type === 'accepted') return Promise.resolve();
    if (existing?.type === 'accepting') return existing.promise;
    const invite =
      typeof invitation === 'string' ? existing?.invite : invitation;
    let acceptedRoom = existing?.type === 'retry' ? existing.roomId : undefined;
    const operation = this.queueRoomTransition(async () => {
      const roomId =
        acceptedRoom ?? (await this.social.acceptInvite(inviteId)).roomId;
      acceptedRoom = roomId;
      if (this.room.getRoom()) await this.room.leave();
      await this.room.join(displayName, roomId);
      this.social.clearRequestedRoom(roomId);
      this.invitations.set(inviteId, { type: 'accepted' });
      this.changed();
    });
    this.invitations.set(inviteId, {
      type: 'accepting',
      promise: operation,
      invite,
    });
    this.changed();
    void operation.catch(() => {
      const current = this.invitations.get(inviteId);
      if (current?.type !== 'accepting' || current.promise !== operation)
        return;
      if (acceptedRoom !== undefined)
        this.invitations.set(inviteId, {
          type: 'retry',
          roomId: acceptedRoom,
          invite,
        });
      else this.invitations.delete(inviteId);
      this.changed();
    });
    return operation;
  }

  createTogether(accountId: string, displayName: string): Promise<void> {
    return this.queueRoomTransition(async () => {
      const created = await this.room.join(displayName);
      await this.social.setPresence({
        displayName,
        participantId: this.participantId,
        roomId: created.code,
      });
      await this.social.invite(accountId, created.code);
    });
  }
}
