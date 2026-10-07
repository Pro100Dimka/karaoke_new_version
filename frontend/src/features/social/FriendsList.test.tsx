import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { OnlineInbox, SocialPerson } from "../../contracts/social";
import { FriendsList } from "./FriendsList";

const mocks = vi.hoisted(() => ({
  requestRoomJoin: vi.fn(async () => undefined),
  invite: vi.fn(async () => undefined),
  setPresence: vi.fn(async () => undefined),
  setRoom: vi.fn(),
  enterRoom: vi.fn(async () => ({ code: "room-new" })),
  notify: vi.fn(),
}));

vi.mock("../../app/AppContext", () => ({
  useApp: () => ({
    room: null,
    setRoom: mocks.setRoom,
    preferences: { language: "ru", displayName: "Boris" },
  }),
  useRoomSession: () => ({ join: mocks.enterRoom }),
}));
vi.mock("../../app/DialogProvider", () => ({ useAsk: () => vi.fn() }));
vi.mock("../../app/NotificationsProvider", () => ({
  useNotify: () => mocks.notify,
}));
vi.mock("../../i18n/useText", () => ({
  useText: () => (key: string, params?: Record<string, string>) =>
    params?.name ? `${key}:${params.name}` : key,
}));
vi.mock("../../services/socialClient", () => ({
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
    screen.queryByRole("button", { name: "requestRoomJoin" }),
  ).not.toBeInTheDocument();

  rerender(<FriendsList inbox={inbox(friend(true))} />);
  fireEvent.click(screen.getByRole("button", { name: "requestRoomJoin" }));

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

  fireEvent.click(screen.getByRole("button", { name: "createRoomTogether" }));

  await waitFor(() => expect(mocks.enterRoom).toHaveBeenCalledWith("Boris"));
  expect(mocks.setPresence).toHaveBeenCalledWith(
    expect.objectContaining({ roomId: "room-new" }),
  );
  expect(mocks.invite).toHaveBeenCalledWith("anna", "room-new");
});
