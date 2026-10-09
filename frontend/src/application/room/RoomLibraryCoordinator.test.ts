import { expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import { RoomSessionController } from "./RoomSessionController";
import { RoomLibraryCoordinator } from "./RoomLibraryCoordinator";

const snapshot = (code: string): RoomStateDto => ({
  code, role: "host", hostId: "self", participants: [], playbackLocked: false,
});

it("ignores a selection response after leaving or switching rooms", async () => {
  let complete!: (value: RoomStateDto) => void;
  const room = { createRoom: vi.fn(async () => snapshot("B")),
    joinRoom: vi.fn(async (code: string) => snapshot(code)),
    leaveRoom: vi.fn(async () => undefined), closeRoom: vi.fn(async () => undefined),
    selectRoomSong: vi.fn(() => new Promise<RoomStateDto>((resolve) => { complete = resolve; })),
    setCollaborativeControl: vi.fn(async () => snapshot("A")),
    updateSharedState: vi.fn(async () => snapshot("A")) };
  const audio = { joinVoiceSession: vi.fn(async () => undefined),
    setRoomPlayoutDelay: vi.fn(async () => undefined),
    leaveVoiceSession: vi.fn(async () => undefined) };
  const session = new RoomSessionController(room, audio, "self");
  session.setSnapshot(snapshot("A"));
  const library = new RoomLibraryCoordinator(session.getScope()!, room);
  const selecting = library.selectSong("song", 1);
  await session.leave();
  await session.join("Singer", "B");
  complete({ ...snapshot("A"), songId: "song", revision: 1 });
  await selecting;
  expect(session.getRoom()?.code).toBe("B");
  expect(session.getRoom()?.songId).toBeUndefined();
});

it("does not apply an older song selection after a newer selection", async () => {
  const completions: Array<(value: RoomStateDto) => void> = [];
  const room = { createRoom: vi.fn(async () => snapshot("A")),
    joinRoom: vi.fn(async (code: string) => snapshot(code)),
    leaveRoom: vi.fn(async () => undefined), closeRoom: vi.fn(async () => undefined),
    selectRoomSong: vi.fn(() => new Promise<RoomStateDto>((resolve) => completions.push(resolve))),
    setCollaborativeControl: vi.fn(async () => snapshot("A")),
    updateSharedState: vi.fn(async () => snapshot("A")) };
  const session = new RoomSessionController(room, {
    joinVoiceSession: vi.fn(async () => undefined),
    setRoomPlayoutDelay: vi.fn(async () => undefined),
    leaveVoiceSession: vi.fn(async () => undefined),
  }, "self");
  session.setSnapshot(snapshot("A"));
  const library = new RoomLibraryCoordinator(session.getScope()!, room);
  const older = library.selectSong("first", 1);
  const newer = library.selectSong("second", 2);
  completions[1]!({ ...snapshot("A"), songId: "second", revision: 2 });
  await newer;
  completions[0]!({ ...snapshot("A"), songId: "first", revision: 1 });
  await older;
  expect(session.getRoom()?.songId).toBe("second");
});

it("does not let an old shared-view response replace a new song selection", async () => {
  let complete!: (value: RoomStateDto) => void;
  const room = { createRoom: vi.fn(async () => snapshot("A")),
    joinRoom: vi.fn(async (code: string) => snapshot(code)),
    leaveRoom: vi.fn(async () => undefined), closeRoom: vi.fn(async () => undefined),
    selectRoomSong: vi.fn(async () => snapshot("A")),
    setCollaborativeControl: vi.fn(async () => snapshot("A")),
    updateSharedState: vi.fn(() => new Promise<RoomStateDto>((resolve) => { complete = resolve; })) };
  const session = new RoomSessionController(room, {
    joinVoiceSession: vi.fn(async () => undefined),
    setRoomPlayoutDelay: vi.fn(async () => undefined),
    leaveVoiceSession: vi.fn(async () => undefined),
  }, "self");
  session.setSnapshot({ ...snapshot("A"), songId: "old", revision: 1 });
  const library = new RoomLibraryCoordinator(session.getScope()!, room);
  const updating = library.publishSharedState({ libraryQuery: "jazz" } as never);
  session.setSnapshot({ ...snapshot("A"), songId: "new", revision: 2 });
  complete({ ...snapshot("A"), songId: "old", revision: 1 });
  await updating;
  expect(session.getRoom()?.songId).toBe("new");
});
