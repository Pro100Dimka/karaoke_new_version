import { expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import { RoomSessionController } from "./RoomSessionController";
import { RoomPlaybackCoordinator } from "./RoomPlaybackCoordinator";

const room = (code = "A"): RoomStateDto => ({ code, role: "host", hostId: "host",
  participants: [], playbackLocked: false, playbackState: "stopped" });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const setup = () => {
  const transport = { createRoom: vi.fn(async () => room()),
    joinRoom: vi.fn(async (code: string) => room(code)),
    leaveRoom: vi.fn(async () => undefined), closeRoom: vi.fn(async () => undefined),
    roomControl: vi.fn(async (): Promise<RoomStateDto> => ({ ...room(), playbackState: "playing" })),
    clearRoomSong: vi.fn(async () => room()),
    updateSharedState: vi.fn(async () => room()),
    setRoomReadiness: vi.fn(async () => room()) };
  const audio = { joinVoiceSession: vi.fn(async () => undefined),
    setRoomPlayoutDelay: vi.fn(async () => undefined),
    leaveVoiceSession: vi.fn(async () => undefined) };
  const session = new RoomSessionController(transport, audio, "self");
  return { transport, session };
};

it("coalesces duplicate starts within one room generation", async () => {
  const { transport, session } = setup();
  session.setSnapshot(room());
  const pending = deferred<RoomStateDto>();
  transport.roomControl.mockReturnValue(pending.promise);
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  const first = playback.start();
  const second = playback.start();
  expect(transport.roomControl).toHaveBeenCalledOnce();
  pending.resolve({ ...room(), playbackState: "playing" });
  await Promise.all([first, second]);
  expect(session.getRoom()?.playbackState).toBe("playing");
});

it("start followed by leave cannot revive the departed room", async () => {
  const { transport, session } = setup();
  session.setSnapshot(room());
  const pending = deferred<RoomStateDto>();
  transport.roomControl.mockReturnValue(pending.promise);
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  const start = playback.start();
  await session.leave();
  pending.resolve({ ...room(), playbackState: "playing" });
  await start;
  expect(session.getRoom()).toBeNull();
});

it("a response from room A cannot update room B", async () => {
  const { transport, session } = setup();
  session.setSnapshot(room());
  const pending = deferred<RoomStateDto>();
  transport.roomControl.mockReturnValue(pending.promise);
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  const start = playback.start();
  await session.leave();
  await session.join("Singer", "B");
  pending.resolve({ ...room(), playbackState: "playing" });
  await start;
  expect(session.getRoom()?.code).toBe("B");
  expect(session.getRoom()?.playbackState).toBe("stopped");
});

it("a failed start releases the single-flight slot for retry", async () => {
  const { transport, session } = setup();
  session.setSnapshot(room());
  transport.roomControl.mockRejectedValueOnce(new Error("Room Server unavailable"));
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  await expect(playback.start()).rejects.toThrow("Room Server unavailable");
  await playback.start();
  expect(transport.roomControl).toHaveBeenCalledTimes(2);
});

it("reports audio preparation once per selection and ignores its stale response", async () => {
  const { transport, session } = setup();
  session.setSnapshot({ ...room(), songId: "song", revision: 1 });
  const pending = deferred<RoomStateDto>();
  transport.setRoomReadiness.mockReturnValue(pending.promise);
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  const first = playback.reportReady("song", 1);
  const second = playback.reportReady("song", 1);
  expect(transport.setRoomReadiness).toHaveBeenCalledOnce();
  await session.leave();
  pending.resolve({ ...room(), songId: "song", revision: 1 });
  await Promise.all([first, second]);
  expect(session.getRoom()).toBeNull();
});

it("does not apply a start response for a song that was replaced while starting", async () => {
  const { transport, session } = setup();
  session.setSnapshot({ ...room(), songId: "old", revision: 1 });
  const pending = deferred<RoomStateDto>();
  transport.roomControl.mockReturnValue(pending.promise);
  const playback = new RoomPlaybackCoordinator(session.getScope()!, transport);
  const start = playback.start();
  session.setSnapshot({ ...room(), songId: "new", revision: 2 });
  pending.resolve({ ...room(), songId: "old", revision: 1, playbackState: "playing" });
  await start;
  expect(session.getRoom()?.songId).toBe("new");
});
