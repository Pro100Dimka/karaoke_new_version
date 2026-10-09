import { expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import { RoomSessionController } from "./RoomSessionController";
import { RoomMembershipCoordinator } from "./RoomMembershipCoordinator";

const snapshot = (code = "A"): RoomStateDto => ({ code, hostId: "self",
  role: "host", participants: [], playbackLocked: false });

it("does not remove a new session's voice when an old removal response arrives", async () => {
  let complete!: (room: RoomStateDto) => void;
  const room = { createRoom: vi.fn(async () => snapshot("B")),
    joinRoom: vi.fn(async (code: string) => snapshot(code)),
    leaveRoom: vi.fn(async () => undefined), closeRoom: vi.fn(async () => undefined),
    removeParticipant: vi.fn(() => new Promise<RoomStateDto>((resolve) => { complete = resolve; })),
    transferHost: vi.fn(async () => snapshot()), startSyncCheck: vi.fn(async () => snapshot()) };
  const audio = { joinVoiceSession: vi.fn(async () => undefined),
    setRoomPlayoutDelay: vi.fn(async () => undefined),
    leaveVoiceSession: vi.fn(async () => undefined),
    removeRemoteParticipant: vi.fn(async () => undefined) };
  const session = new RoomSessionController(room, audio, "self");
  session.setSnapshot(snapshot());
  const membership = new RoomMembershipCoordinator(session.getScope()!, room, audio,
    { copyText: vi.fn(async () => undefined) });
  const removal = membership.removeParticipant("guest");
  await session.leave();
  await session.join("Singer", "B");
  complete(snapshot());
  await removal;
  expect(audio.removeRemoteParticipant).not.toHaveBeenCalled();
  expect(session.getRoom()?.code).toBe("B");
});

it("does not let an old host command replace a new song selection", async () => {
  let complete!: (room: RoomStateDto) => void;
  const room = { createRoom: vi.fn(async () => snapshot()),
    joinRoom: vi.fn(async (code: string) => snapshot(code)),
    leaveRoom: vi.fn(async () => undefined), closeRoom: vi.fn(async () => undefined),
    removeParticipant: vi.fn(async () => snapshot()),
    transferHost: vi.fn(() => new Promise<RoomStateDto>((resolve) => { complete = resolve; })),
    startSyncCheck: vi.fn(async () => snapshot()) };
  const session = new RoomSessionController(room, {
    joinVoiceSession: vi.fn(async () => undefined),
    setRoomPlayoutDelay: vi.fn(async () => undefined),
    leaveVoiceSession: vi.fn(async () => undefined),
  }, "self");
  session.setSnapshot({ ...snapshot(), songId: "old", revision: 1 });
  const membership = new RoomMembershipCoordinator(session.getScope()!, room,
    { removeRemoteParticipant: vi.fn(async () => undefined) },
    { copyText: vi.fn(async () => undefined) });
  const transfer = membership.transferHost("guest");
  session.setSnapshot({ ...snapshot(), songId: "new", revision: 2 });
  complete({ ...snapshot(), songId: "old", revision: 1 });
  await transfer;
  expect(session.getRoom()?.songId).toBe("new");
});
