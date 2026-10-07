import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { OnlineInbox, SocialPerson } from "../../contracts/social";
import { SocialAlerts } from "./SocialAlerts";

const mocks = vi.hoisted(() => ({
  setRoom: vi.fn(),
  room: null as null | { code: string },
  acceptInvite: vi.fn(),
  invite: vi.fn(),
  approveJoinRequest: vi.fn(),
  isRequestedRoom: vi.fn(() => false),
  clearRequestedRoom: vi.fn(),
  declineFriend: vi.fn(),
  enterRoom: vi.fn(),
  leaveRoom: vi.fn(async () => undefined),
  notify: vi.fn(),
}));

vi.mock("../../app/AppContext", () => ({
  useApp: () => ({
    room: mocks.room,
    setRoom: mocks.setRoom,
    preferences: { displayName: "Boris" },
  }),
  useRoomSession: () => ({ join: mocks.enterRoom, leave: mocks.leaveRoom }),
}));
vi.mock("../../app/SocialProvider", async () => {
  const { RoomInvitationCoordinator } = await import("../../application/social/RoomInvitationCoordinator");
  const { FriendRelationsCoordinator } = await import("../../application/social/FriendRelationsCoordinator");
  const invitations = new RoomInvitationCoordinator({
    acceptInvite: mocks.acceptInvite, clearRequestedRoom: mocks.clearRequestedRoom,
    isRequestedRoom: mocks.isRequestedRoom, approveJoinRequest: mocks.approveJoinRequest,
    declineInvite: vi.fn(async () => undefined), requestRoomJoin: vi.fn(async () => undefined),
    invite: mocks.invite, setPresence: vi.fn(async () => undefined),
  }, { getRoom: () => mocks.room as never, leave: mocks.leaveRoom,
    join: mocks.enterRoom }, "self");
  const friends = new FriendRelationsCoordinator({
    acceptFriend: vi.fn(async () => undefined), declineFriend: mocks.declineFriend,
    requestFriend: vi.fn(), cancelRequest: vi.fn(), removeFriend: vi.fn(),
  }, { copyText: vi.fn(async () => undefined) });
  return { useRoomInvitations: () => invitations,
    useFriendRelations: () => friends, useSocial: () => ({ type: "offline" }),
    useSocialDirectory: () => ({ avatar: vi.fn() }) };
});
vi.mock("../../app/NotificationsProvider", () => ({
  useNotify: () => mocks.notify,
}));
vi.mock("../../i18n/useText", () => ({
  useText: () => (key: string, params?: Record<string, string>) =>
    params?.name ? `${key}:${params.name}` : key,
}));
vi.mock("../../services/socialClient", () => ({
  socialClient: {
    acceptInvite: mocks.acceptInvite,
    invite: mocks.invite,
    approveJoinRequest: mocks.approveJoinRequest,
    isRequestedRoom: mocks.isRequestedRoom,
    clearRequestedRoom: mocks.clearRequestedRoom,
    declineInvite: vi.fn(),
    acceptFriend: vi.fn(),
    declineFriend: mocks.declineFriend,
    avatar: vi.fn(() => new Promise(() => undefined)),
  },
}));

const anna: SocialPerson = {
  accountId: "anna",
  displayName: "Anna",
  avatarVersion: 0,
  presence: "InRoom",
  roomId: "room-a",
  lastSeenAt: null,
  relation: "Friend",
};
const inbox = (extra: Partial<OnlineInbox>): OnlineInbox => ({
  type: "inbox",
  me: {
    accountId: "boris",
    displayName: "Boris",
    friendCode: "AAAA-BBBB",
    transferCode: "",
    avatarVersion: 0,
  },
  friends: [anna],
  friendRequests: [],
  outgoingRequests: [],
  invites: [],
  notices: [],
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isRequestedRoom.mockReturnValue(false);
  mocks.room = null;
});

it("an accepted invitation leaves the current room and enters the friend's", async () => {
  mocks.room = { code: "room-b" };
  mocks.acceptInvite.mockResolvedValue({ roomId: "room-a" });
  mocks.enterRoom.mockResolvedValue({ code: "room-a" });
  render(
    <SocialAlerts
      inbox={inbox({
        invites: [
          { inviteId: "i1", roomId: "room-a", sender: anna, createdAt: "" },
        ],
      })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "acceptAction" }));

  await waitFor(() => expect(mocks.enterRoom).toHaveBeenCalled());
  expect(mocks.acceptInvite).toHaveBeenCalledWith("i1");
  expect(mocks.leaveRoom).toHaveBeenCalledWith();
  expect(mocks.enterRoom).toHaveBeenCalledWith("Boris", "room-a");
});

it("a friend request put off for later leaves the corner but can still be answered in the Friends window", () => {
  render(
    <SocialAlerts
      inbox={inbox({ friendRequests: [{ ...anna, relation: "Incoming" }] })}
    />,
  );
  expect(screen.getByText("friendRequestAlert:Anna")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "laterAction" }));

  expect(screen.queryByText("friendRequestAlert:Anna")).not.toBeInTheDocument();
  expect(mocks.declineFriend).not.toHaveBeenCalled();
});

it("lets the host approve a room join request instead of sending another invitation", async () => {
  mocks.room = { code: "room-a" };
  render(
    <SocialAlerts
      inbox={inbox({
        notices: [{ kind: "JoinRequested", person: anna, roomId: "room-a" }],
      })}
    />,
  );

  expect(screen.getByText("joinRequested:Anna")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "acceptAction" }));

  await waitFor(() =>
    expect(mocks.approveJoinRequest).toHaveBeenCalledWith("anna", "room-a"),
  );
  expect(mocks.invite).not.toHaveBeenCalled();
});

it("enters the requested room as soon as its host approves the join request", async () => {
  mocks.isRequestedRoom.mockReturnValue(true);
  mocks.acceptInvite.mockResolvedValue({ roomId: "room-a" });
  mocks.enterRoom.mockResolvedValue({ code: "room-a" });
  render(
    <SocialAlerts
      inbox={inbox({
        invites: [
          {
            inviteId: "approved",
            roomId: "room-a",
            sender: anna,
            createdAt: "",
          },
        ],
      })}
    />,
  );

  await waitFor(() =>
    expect(mocks.acceptInvite).toHaveBeenCalledWith("approved"),
  );
  await waitFor(() =>
    expect(mocks.enterRoom).toHaveBeenCalledWith("Boris", "room-a"),
  );
  expect(mocks.clearRequestedRoom).toHaveBeenCalledWith("room-a");
});
