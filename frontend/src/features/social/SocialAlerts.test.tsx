import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { OnlineInbox, SocialPerson } from "../../contracts/social";
import { SocialAlerts } from "./SocialAlerts";

const mocks = vi.hoisted(() => ({
  setRoom: vi.fn(),
  room: null as null | { code: string },
  acceptInvite: vi.fn(),
  invite: vi.fn(),
  declineFriend: vi.fn(),
  enterRoom: vi.fn(),
  leaveRoom: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../../app/AppContext", () => ({
  useApp: () => ({ room: mocks.room, setRoom: mocks.setRoom, preferences: { displayName: "Boris" } }),
}));
vi.mock("../../app/NotificationsProvider", () => ({ useNotify: () => mocks.notify }));
vi.mock("../../i18n/useText", () => ({
  useText: () => (key: string, params?: Record<string, string>) => (params?.name ? `${key}:${params.name}` : key),
}));
vi.mock("../../services/socialClient", () => ({
  socialClient: {
    acceptInvite: mocks.acceptInvite,
    invite: mocks.invite,
    declineInvite: vi.fn(),
    acceptFriend: vi.fn(),
    declineFriend: mocks.declineFriend,
    avatar: vi.fn(() => new Promise(() => undefined)),
  },
}));
vi.mock("../room/enterRoom", () => ({ enterRoom: mocks.enterRoom, leaveRoom: mocks.leaveRoom }));

const anna: SocialPerson = {
  accountId: "anna", displayName: "Anna", avatarVersion: 0, presence: "InRoom", roomId: "room-a", lastSeenAt: null,
  relation: "Friend",
};
const inbox = (extra: Partial<OnlineInbox>): OnlineInbox => ({
  type: "inbox",
  me: { accountId: "boris", displayName: "Boris", friendCode: "AAAA-BBBB", transferCode: "", avatarVersion: 0 },
  friends: [anna], friendRequests: [], outgoingRequests: [], invites: [], notices: [], ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.room = null;
});

it("an accepted invitation leaves the current room and enters the friend's", async () => {
  mocks.room = { code: "room-b" };
  mocks.acceptInvite.mockResolvedValue({ roomId: "room-a" });
  mocks.enterRoom.mockResolvedValue({ code: "room-a" });
  render(<SocialAlerts inbox={inbox({ invites: [{ inviteId: "i1", roomId: "room-a", sender: anna, createdAt: "" }] })} />);

  fireEvent.click(screen.getByRole("button", { name: "acceptAction" }));

  await waitFor(() => expect(mocks.setRoom).toHaveBeenCalledWith({ code: "room-a" }));
  expect(mocks.acceptInvite).toHaveBeenCalledWith("i1");
  expect(mocks.leaveRoom).toHaveBeenCalledWith("room-b");
  expect(mocks.enterRoom).toHaveBeenCalledWith("Boris", "room-a");
});

it("a friend request put off for later leaves the corner but can still be answered in the Friends window", () => {
  render(<SocialAlerts inbox={inbox({ friendRequests: [{ ...anna, relation: "Incoming" }] })} />);
  expect(screen.getByText("friendRequestAlert:Anna")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "laterAction" }));

  expect(screen.queryByText("friendRequestAlert:Anna")).not.toBeInTheDocument();
  expect(mocks.declineFriend).not.toHaveBeenCalled();
});

it("shows a room join request to the host and lets the host invite the requester", async () => {
  mocks.room = { code: "room-a" };
  render(<SocialAlerts inbox={inbox({ notices: [{ kind: "JoinRequested", person: anna, roomId: "room-a" }] })} />);

  expect(screen.getByText("joinRequested:Anna")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "inviteToRoom" }));

  await waitFor(() => expect(mocks.invite).toHaveBeenCalledWith("anna", "room-a"));
});

it("shows nothing while the friends server cannot be reached", () => {
  const { container } = render(<SocialAlerts inbox={{ type: "offline" }} />);
  expect(container).toBeEmptyDOMElement();
});
