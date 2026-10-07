import { expect, it, vi } from "vitest";
import { FriendRelationsCoordinator } from "./FriendRelationsCoordinator";

it("accepts an incoming relation and requests a new one through distinct social intents", async () => {
  const social = { acceptFriend: vi.fn(async () => undefined),
    requestFriend: vi.fn(async () => ({ relation: "Requested", person: {} })),
    declineFriend: vi.fn(), cancelRequest: vi.fn(), removeFriend: vi.fn() };
  const friends = new FriendRelationsCoordinator(social as never,
    { copyText: vi.fn(async () => undefined) });
  await friends.befriend({ accountId: "known", relation: "Incoming" } as never);
  await friends.befriend({ accountId: "new", relation: "None" } as never);
  expect(social.acceptFriend).toHaveBeenCalledWith("known");
  expect(social.requestFriend).toHaveBeenCalledWith({ accountId: "new" });
});

it("returns the relation for a person found in room history", async () => {
  const social = { requestFriend: vi.fn(async () => ({ relation: "Requested", person: {} })),
    acceptFriend: vi.fn(), declineFriend: vi.fn(), cancelRequest: vi.fn(),
    removeFriend: vi.fn() };
  const friends = new FriendRelationsCoordinator(social as never,
    { copyText: vi.fn(async () => undefined) });
  await expect(friends.requestAccount("account")).resolves.toBe("Requested");
});
