import type {
  ParticipantPerson,
  RoomStay,
  SocialInbox,
  SocialMe,
  SocialPerson,
  SocialRelation,
} from "../contracts/social";
import { bridgedHttp } from "./desktopBridge";
import { desktopClient } from "./desktopClient";
import { readJson, writeJson } from "../shared/storage/localStore";

const request = <T>(
  method: PythonBridgeRequest["method"],
  path: string,
  body?: unknown,
): Promise<T> =>
  bridgedHttp<T>(
    "roomRequest",
    { method, path: `/social${path}`, body },
    "Room server request failed",
  );

const isInbox = (message: unknown): message is SocialInbox =>
  !!message &&
  typeof message === "object" &&
  ((message as { type?: unknown }).type === "inbox" ||
    (message as { type?: unknown }).type === "offline");

// Photos are fetched once per account and version; a new version (a changed photo) is fetched anew.
const avatars = new Map<string, Promise<string>>();
const requestedRoomsKey = "ad-voice.requested-rooms";
const requestedRooms = (): string[] => {
  const value = readJson(requestedRoomsKey);
  return Array.isArray(value)
    ? value.filter((room): room is string => typeof room === "string")
    : [];
};
const saveRequestedRooms = (rooms: string[]) =>
  writeJson(requestedRoomsKey, [...new Set(rooms)]);

/**
 * Friends, invitations and the profile. What changes by itself arrives pushed over the app's one
 * socket (`subscribe`); only the user's own actions are requests.
 */
export const socialClient = {
  /** The latest inbox at once, then every one the server pushes. */
  subscribe(listener: (inbox: SocialInbox) => void): () => void {
    let active = true;
    void desktopClient.socialLatest().then((message) => {
      if (active && isInbox(message)) listener(message);
    });
    const stop = desktopClient.onSocialInbox((message) => {
      if (isInbox(message)) listener(message);
    });
    return () => {
      active = false;
      stop();
    };
  },
  setPresence: (presence: SocialPresenceUpdate): Promise<void> =>
    desktopClient.socialPresence(presence),
  me: (): Promise<SocialMe> => request("GET", "/me"),
  requestFriend: (target: { friendCode: string } | { accountId: string }) =>
    request<{ relation: SocialRelation; person: SocialPerson }>(
      "POST",
      "/friends/requests",
      target,
    ),
  acceptFriend: (accountId: string) =>
    request<void>(
      "POST",
      `/friends/requests/${encodeURIComponent(accountId)}/accept`,
    ),
  declineFriend: (accountId: string) =>
    request<void>(
      "POST",
      `/friends/requests/${encodeURIComponent(accountId)}/decline`,
    ),
  cancelRequest: (accountId: string) =>
    request<void>(
      "DELETE",
      `/friends/requests/${encodeURIComponent(accountId)}`,
    ),
  removeFriend: (accountId: string) =>
    request<void>("DELETE", `/friends/${encodeURIComponent(accountId)}`),
  invite: (accountId: string, roomId: string) =>
    request<void>("POST", "/invites", { accountId, roomId }),
  requestRoomJoin: async (accountId: string, roomId: string): Promise<void> => {
    await request<void>("POST", "/join-requests", { accountId, roomId });
    saveRequestedRooms([...requestedRooms(), roomId]);
  },
  /** Host approval uses the existing authenticated invitation, but a requested invite is auto-accepted. */
  approveJoinRequest: (accountId: string, roomId: string) =>
    request<void>("POST", "/invites", { accountId, roomId }),
  isRequestedRoom: (roomId: string): boolean =>
    requestedRooms().includes(roomId),
  clearRequestedRoom: (roomId: string): void =>
    saveRequestedRooms(requestedRooms().filter((id) => id !== roomId)),
  acceptInvite: (inviteId: string) =>
    request<{ roomId: string }>(
      "POST",
      `/invites/${encodeURIComponent(inviteId)}/accept`,
    ),
  declineInvite: (inviteId: string) =>
    request<void>("POST", `/invites/${encodeURIComponent(inviteId)}/decline`),
  history: (): Promise<RoomStay[]> => request("GET", "/history"),
  people: (participantIds: string[]): Promise<ParticipantPerson[]> =>
    request("POST", "/people", { participantIds }),
  setAvatar: (mime: string, data: string): Promise<SocialMe> =>
    request("PUT", "/avatar", { mime, data }),
  clearAvatar: (): Promise<SocialMe> => request("DELETE", "/avatar"),
  transfer: (transferCode: string): Promise<SocialMe> =>
    request("POST", "/transfer", { transferCode }),
  /** A person's photo as a data URL. */
  avatar(accountId: string, version: number): Promise<string> {
    const key = `${accountId}:${version}`;
    let photo = avatars.get(key);
    if (!photo) {
      photo = request<{ mime: string; data: string }>(
        "GET",
        `/avatars/${encodeURIComponent(accountId)}`,
      ).then(({ mime, data }) => `data:${mime};base64,${data}`);
      photo.catch(() => avatars.delete(key));
      avatars.set(key, photo);
    }
    return photo;
  },
};
