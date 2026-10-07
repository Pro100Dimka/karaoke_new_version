import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { OnlineInbox } from "../../contracts/social";
import { FriendRequests } from "./FriendRequests";

const mocks = vi.hoisted(() => ({
  copyText: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../../app/NotificationsProvider", () => ({
  useNotify: () => mocks.notify,
}));
vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));
vi.mock("../../services/desktopClient", () => ({
  desktopClient: { copyText: mocks.copyText },
}));

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
  render(<FriendRequests inbox={inbox} />);

  fireEvent.click(screen.getByRole("button", { name: "copyCode" }));

  await waitFor(() =>
    expect(mocks.notify).toHaveBeenCalledWith("unavailable", "error"),
  );
  expect(mocks.notify).not.toHaveBeenCalledWith("codeCopied", "success");
});
