import { expect, it, vi } from "vitest";

vi.mock("./SocialIdentity", () => ({
  deviceSecret: async () => "secret-of-this-computer",
}));

it("derives the same participant id from a room key as the room server does", async () => {
  const { roomParticipantIdFor } = await import("./RoomIdentity");
  // python: participant_id_for("h" * 64)
  expect(roomParticipantIdFor("h".repeat(64))).toBe(
    "28222914e340f5d649f6f70fca6f8db2",
  );
});

it("sends a private key whose hash is the participant id, never the device secret itself", async () => {
  const {
    roomKeyHeader,
    roomParticipantId,
    roomParticipantIdFor,
    withRoomKey,
  } = await import("./RoomIdentity");
  const headers = await withRoomKey({ "X-Participant-Id": "x" });
  const key = headers[roomKeyHeader]!;
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(key).not.toBe("secret-of-this-computer");
  expect(await roomParticipantId()).toBe(roomParticipantIdFor(key));
});
