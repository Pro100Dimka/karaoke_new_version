import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { OnlineInbox } from "../../../../contracts/social";
import { FriendRequests } from "./requests";
import { QueryProvider } from '../../../../test/QueryProvider';

const mocks = vi.hoisted(() => ({
  copyText: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../../../../providers/notifications", () => ({
  useNotify: () => mocks.notify,
  useErrorHandler: () => (error: Error) => mocks.notify(error.message, 'error'),
}));

vi.mock("../../../../services/desktopClient", () => ({
  desktopClient: { copyText: mocks.copyText },
}));
vi.mock("../../../../providers/social", async () => {
  const { FriendRelationsCoordinator } = await import("../../../../application/social/FriendRelationsCoordinator");
  const friends = new FriendRelationsCoordinator({
    requestFriend: vi.fn(), acceptFriend: vi.fn(), declineFriend: vi.fn(),
    cancelRequest: vi.fn(), removeFriend: vi.fn(),
  }, { copyText: mocks.copyText });
  return { friendRelations: friends,
    useSocial: () => ({ type: "offline" }),
    useSocialDirectory: () => ({ avatar: vi.fn() }) };
});

const inbox: OnlineInbox = {
  type: "inbox",
  me: {
    accountId: "me",
    displayName: "Me",
    friendCode: "AAAA-BBBB",
    transferCode: "",
    avatarVersion: 0,
  },
  friends: [],
  friendRequests: [],
  outgoingRequests: [],
  invites: [],
  notices: [],
};

beforeEach(() => vi.clearAllMocks());

it("reports a clipboard failure instead of claiming the friend code was copied", async () => {
  mocks.copyText.mockRejectedValue(new Error("Clipboard unavailable"));
  render(<FriendRequests inbox={inbox} />, { wrapper: QueryProvider });

  fireEvent.click(screen.getByRole("button", { name: "copyCode: AAAA-BBBB" }));

  await waitFor(() =>
    expect(mocks.notify).toHaveBeenCalledWith("Clipboard unavailable", "error"),
  );
  expect(mocks.notify).not.toHaveBeenCalledWith("codeCopied", "success");
});
