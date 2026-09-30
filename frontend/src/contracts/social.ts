/** Friends and profiles, as the room server's /social API and socket describe them. */

export type SocialPresence = "Offline" | "Online" | "InRoom";
export type SocialRelation = "Self" | "Friend" | "Requested" | "Incoming" | "None";

export interface SocialMe {
  accountId: string;
  displayName: string;
  friendCode: string;
  transferCode: string;
  avatarVersion: number;
}

export interface SocialPerson {
  accountId: string;
  displayName: string;
  avatarVersion: number;
  presence: SocialPresence;
  roomId: string | null;
  lastSeenAt: string | null;
  relation: SocialRelation;
}

export interface SocialInvite {
  inviteId: string;
  roomId: string;
  sender: SocialPerson;
  createdAt: string;
}

export interface SocialNotice {
  kind: "FriendAccepted" | "InviteAccepted" | "InviteDeclined";
  person: SocialPerson;
  roomId: string | null;
}

/** Pushed by the server whenever it changes; "offline" while the server cannot be reached. */
export type SocialInbox =
  | { type: "offline" }
  | {
      type: "inbox";
      me: SocialMe;
      friends: SocialPerson[];
      friendRequests: SocialPerson[];
      outgoingRequests: SocialPerson[];
      invites: SocialInvite[];
      notices: SocialNotice[];
    };

export type OnlineInbox = Extract<SocialInbox, { type: "inbox" }>;

export interface RoomStayPerson {
  participantId: string;
  displayName: string;
  /** Unknown for someone whose app never said who they are (an older version). */
  person: SocialPerson | null;
}

export interface RoomStay {
  roomId: string;
  joinedAt: string;
  leftAt: string | null;
  seconds: number;
  people: RoomStayPerson[];
}

export interface ParticipantPerson {
  participantId: string;
  person: SocialPerson;
}
