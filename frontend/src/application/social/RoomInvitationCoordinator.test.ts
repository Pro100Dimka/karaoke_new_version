import { expect, it, vi } from "vitest";
import { RoomInvitationCoordinator } from "./RoomInvitationCoordinator";

it("accepts an invitation through the room session and clears the pending request only after join", async () => {
  const events: string[] = [];
  const social = {
    acceptInvite: vi.fn(async () => ({ roomId: "B" })),
    clearRequestedRoom: vi.fn(() => { events.push("clear"); }),
  };
  const room = {
    getRoom: () => ({ code: "A" }),
    leave: vi.fn(async () => { events.push("leave"); }),
    join: vi.fn(async () => { events.push("join"); return { code: "B" }; }),
  };
  const invitations = new RoomInvitationCoordinator(social as never, room as never);
  await invitations.accept("invite", "Singer");
  expect(events).toEqual(["leave", "join", "clear"]);
});

it("keeps a failed invitation join retryable", async () => {
  const social = { acceptInvite: vi.fn(async () => ({ roomId: "B" })),
    clearRequestedRoom: vi.fn() };
  const room = { getRoom: () => null, leave: vi.fn(),
    join: vi.fn().mockRejectedValueOnce(new Error("AudioService unavailable"))
      .mockResolvedValueOnce({ code: "B" }) };
  const invitations = new RoomInvitationCoordinator(social as never, room as never);
  await expect(invitations.accept("invite", "Singer")).rejects.toThrow("AudioService unavailable");
  expect(social.clearRequestedRoom).not.toHaveBeenCalled();
  await invitations.accept("invite", "Singer");
  expect(social.clearRequestedRoom).toHaveBeenCalledWith("B");
});

it("does not join twice while an accepted invitation remains in the inbox", async () => {
  const social = { acceptInvite: vi.fn(async () => ({ roomId: "B" })),
    clearRequestedRoom: vi.fn() };
  const room = { getRoom: () => null, leave: vi.fn(),
    join: vi.fn(async () => ({ code: "B" })) };
  const invitations = new RoomInvitationCoordinator(social as never, room as never);
  await invitations.accept("invite", "Singer");
  await invitations.accept("invite", "Singer");
  expect(room.join).toHaveBeenCalledOnce();
});
