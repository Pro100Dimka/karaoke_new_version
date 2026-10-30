import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { OnlineInbox, SocialPerson } from "../../../../contracts/social";
import { FriendsList } from "./friends-tab";

const mocks = vi.hoisted(() => ({
  requestRoomJoin: vi.fn(async () => undefined),
  invite: vi.fn(async () => undefined),
  setPresence: vi.fn(async () => undefined),
  setRoom: vi.fn(),
  enterRoom: vi.fn(async () => ({ code: "room-new" })),
  notify: vi.fn(),
}));

vi.mock("../../../../providers/application", () => ({
  useApp: () => ({
    room: null,
    setRoom: mocks.setRoom,
    preferences: { language: "ru", displayName: "Boris" },
  }),
  roomSession: { join: mocks.enterRoom },
}));
vi.mock("../../../../providers/social", async () => {
  const { RoomInvitationCoordinator } = await import("../../../../application/social/RoomInvitationCoordinator");
  const { FriendRelationsCoordinator } = await import("../../../../application/social/FriendRelationsCoordinator");
  const invitations = new RoomInvitationCoordinator({
    requestRoomJoin: mocks.requestRoomJoin, invite: mocks.invite,
    setPresence: mocks.setPresence, acceptInvite: vi.fn(), declineInvite: vi.fn(),
    clearRequestedRoom: vi.fn(), isRequestedRoom: vi.fn(() => false),
    approveJoinRequest: vi.fn(),
  }, { getRoom: () => null, leave: vi.fn(), join: mocks.enterRoom } as never, "self");
  const friends = new FriendRelationsCoordinator({
    removeFriend: vi.fn(async () => undefined), acceptFriend: vi.fn(),
    declineFriend: vi.fn(), requestFriend: vi.fn(), cancelRequest: vi.fn(),
  }, { copyText: vi.fn(async () => undefined) });
  return { useRoomInvitations: () => invitations,
    friendRelations: friends, useSocial: () => ({ type: "offline" }),
    useSocialDirectory: () => ({ avatar: vi.fn() }) };
});
vi.mock("../../../../providers/dialog", () => ({ ask: vi.fn() }));
vi.mock("../../../../providers/notifications", () => ({
  useNotify: () => mocks.notify,
}));

vi.mock("../../../../services/socialClient", () => ({
  socialClient: {
    requestRoomJoin: mocks.requestRoomJoin,
    invite: mocks.invite,
    setPresence: mocks.setPresence,
    removeFriend: vi.fn(),
    avatar: vi.fn(() => new Promise(() => undefined)),
  },
}));

const friend = (host: boolean) =>
  ({
    accountId: "anna",
    displayName: "Anna",
    avatarVersion: 0,
    presence: "InRoom",
    roomId: "room-a",
    lastSeenAt: null,
    relation: "Friend",
    isRoomHost: host,
  }) as unknown as SocialPerson;
const inbox = (person: SocialPerson): OnlineInbox => ({
  type: "inbox",
  me: {
    accountId: "boris",
    displayName: "Boris",
    friendCode: "AAAA-BBBB",
    transferCode: "",
    avatarVersion: 0,
  },
  friends: [person],
  friendRequests: [],
  outgoingRequests: [],
  invites: [],
  notices: [],
});

beforeEach(() => vi.clearAllMocks());

it("lets a friend request entry to a room only from the friend who hosts it", async () => {
  const { rerender } = render(<FriendsList inbox={inbox(friend(false))} />);
  expect(
    screen.queryByRole("button", { name: "Попроситься в комнату" }),
  ).not.toBeInTheDocument();

  rerender(<FriendsList inbox={inbox(friend(true))} />);
  fireEvent.click(screen.getByRole("button", { name: "Попроситься в комнату" }));

  await waitFor(() =>
    expect(mocks.requestRoomJoin).toHaveBeenCalledWith("anna", "room-a"),
  );
});

it("creates a hosted room and invites an online friend when both are outside rooms", async () => {
  render(
    <FriendsList
      inbox={inbox({ ...friend(false), presence: "Online", roomId: null })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Создать комнату вместе" }));

  await waitFor(() => expect(mocks.enterRoom).toHaveBeenCalledWith("Boris"));
  expect(mocks.setPresence).toHaveBeenCalledWith(
    expect.objectContaining({ roomId: "room-new" }),
  );
  expect(mocks.invite).toHaveBeenCalledWith("anna", "room-new");
});

vi.mock("../../../../providers/store", () => ({ store: {
  get online() { return { room: null }; },
  inbox: { type: "offline" },
  get preferences() { return { language: "ru", displayName: "Boris" }; }
} }));
