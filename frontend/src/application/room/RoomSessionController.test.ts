import { expect, it, vi } from "vitest";
import type { AudioServiceClient, RoomClient } from "../../contracts/clients";
import type { RoomStateDto } from "../../contracts/models";
import { RoomSessionController } from "./RoomSessionController";

const snapshot = (code = "room-a"): RoomStateDto => ({
  code,
  hostId: "host",
  role: "host",
  participants: [],
  playbackLocked: false,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const setup = () => {
  const room = {
    createRoom: vi.fn(async () => snapshot()),
    joinRoom: vi.fn(async () => snapshot()),
    leaveRoom: vi.fn(async (): Promise<void> => undefined),
    closeRoom: vi.fn(async (): Promise<void> => undefined),
  };
  const audio = {
    joinVoiceSession: vi.fn(async (): Promise<void> => undefined),
    leaveVoiceSession: vi.fn(async (): Promise<void> => undefined),
  };
  const session = new RoomSessionController(
    room as Pick<RoomClient, "createRoom" | "joinRoom" | "leaveRoom" | "closeRoom">,
    audio as Pick<AudioServiceClient, "joinVoiceSession" | "leaveVoiceSession">,
    "self",
  );
  return { room, audio, session };
};

it("owns the local joining to joined transition after server and voice registration", async () => {
  const { room, audio, session } = setup();
  const created = { ...snapshot(), serverClockOffsetMilliseconds: 123 };
  room.createRoom.mockResolvedValue(created);
  const states: string[] = [];
  session.subscribe(() => states.push(session.getState().type));

  await expect(session.join("Singer")).resolves.toEqual(created);

  expect(room.createRoom).toHaveBeenCalledWith("Singer");
  expect(audio.joinVoiceSession).toHaveBeenCalledWith("room-a", "self", 123);
  expect(states).toEqual(["joining", "joined"]);
  expect(session.getRoom()).toEqual(created);
});

it("coalesces duplicate join commands and does not open voice twice", async () => {
  const { room, audio, session } = setup();
  const pending = deferred<RoomStateDto>();
  room.createRoom.mockReturnValue(pending.promise);

  const first = session.join("Singer");
  const duplicate = session.join("Singer");
  expect(room.createRoom).toHaveBeenCalledOnce();
  pending.resolve(snapshot());
  await Promise.all([first, duplicate]);
  expect(audio.joinVoiceSession).toHaveBeenCalledOnce();
});

it("compensates a partial join when AudioService is unavailable, then allows retry", async () => {
  const { room, audio, session } = setup();
  audio.joinVoiceSession.mockRejectedValueOnce(new Error("AudioService unavailable"));

  await expect(session.join("Singer")).rejects.toThrow("AudioService unavailable");
  expect(room.leaveRoom).toHaveBeenCalledWith("room-a");
  expect(audio.leaveVoiceSession).toHaveBeenCalledOnce();
  expect(session.getRoom()).toBeNull();
  expect(session.getState().type).toBe("failed");

  await expect(session.join("Singer")).resolves.toEqual(snapshot());
  expect(session.getState().type).toBe("joined");
});

it("does not open voice or retain a room when Room Server rejects join", async () => {
  const { room, audio, session } = setup();
  room.createRoom.mockRejectedValueOnce(new Error("Room Server unavailable"));

  await expect(session.join("Singer")).rejects.toThrow("Room Server unavailable");
  expect(audio.joinVoiceSession).not.toHaveBeenCalled();
  expect(session.getRoom()).toBeNull();
});

it("cancels a late join response when leave wins and cleans the server room", async () => {
  const { room, audio, session } = setup();
  const pending = deferred<RoomStateDto>();
  room.createRoom.mockReturnValue(pending.promise);

  const joining = session.join("Singer");
  const leaving = session.leave();
  pending.resolve(snapshot());

  await expect(joining).rejects.toMatchObject({ name: "AbortError" });
  await leaving;
  expect(room.leaveRoom).toHaveBeenCalledWith("room-a");
  expect(audio.joinVoiceSession).not.toHaveBeenCalled();
  expect(session.getState().type).toBe("disconnected");
});

it("ignores a previous room's late snapshot after switching rooms", async () => {
  const { room, session } = setup();
  session.setSnapshot(snapshot("old-room"));
  await session.leave();
  room.createRoom.mockResolvedValue(snapshot("new-room"));
  await session.join("Singer");

  session.setSnapshot(snapshot("old-room"));
  expect(session.getRoom()?.code).toBe("new-room");
});

it("keeps reconnecting separate from the server's authoritative room snapshot", () => {
  const { session } = setup();
  session.setSnapshot(snapshot());
  session.setSnapshot({ ...snapshot(), connectionStatus: "reconnecting" });
  expect(session.getState().type).toBe("recovering");
  session.setSnapshot({ ...snapshot(), connectionStatus: "connected" });
  expect(session.getState().type).toBe("joined");
});

it("coalesces duplicate leaves and never resurrects a late response", async () => {
  const { room, audio, session } = setup();
  const pending = deferred<void>();
  room.leaveRoom.mockReturnValue(pending.promise);
  session.setSnapshot(snapshot());

  const first = session.leave();
  const duplicate = session.leave();
  expect(room.leaveRoom).toHaveBeenCalledOnce();
  pending.resolve();
  await Promise.all([first, duplicate]);
  session.setSnapshot(snapshot());
  expect(audio.leaveVoiceSession).toHaveBeenCalledOnce();
  expect(session.getRoom()).toBeNull();
});

it("keeps a joined room and voice when closing it fails", async () => {
  const { room, audio, session } = setup();
  session.setSnapshot(snapshot());
  room.closeRoom.mockRejectedValueOnce(new Error("Room Server unavailable"));

  await expect(session.close()).rejects.toThrow("Room Server unavailable");
  expect(session.getRoom()?.code).toBe("room-a");
  expect(audio.leaveVoiceSession).not.toHaveBeenCalled();
});

it("rejects a late result from an earlier generation of the same room", async () => {
  const { session } = setup();
  await session.join("Singer", "room-a");
  const oldScope = session.getScope();
  expect(oldScope).not.toBeNull();

  await session.leave();
  await session.join("Singer", "room-a");
  const current = { ...snapshot(), playbackState: "playing" as const };
  expect(oldScope?.setSnapshot(current)).toBe(false);
  expect(session.getRoom()?.playbackState).not.toBe("playing");
  expect(session.getScope()).not.toBe(oldScope);
});

it("invalidates in-flight session work before the leave request finishes", async () => {
  const { room, session } = setup();
  const pending = deferred<void>();
  await session.join("Singer");
  const scope = session.getScope();
  room.leaveRoom.mockReturnValue(pending.promise);

  const leaving = session.leave();
  expect(scope?.signal.aborted).toBe(true);
  expect(scope?.setSnapshot(snapshot())).toBe(false);
  pending.resolve();
  await leaving;
});

it("restores a room after renderer reload using the same participant and reopens voice", async () => {
  let saved: string | null = null;
  const persistence = {
    load: () => saved,
    save: vi.fn((code: string) => { saved = code; }),
    clear: vi.fn(() => { saved = null; }),
  };
  const first = setup();
  const original = new RoomSessionController(first.room, first.audio, "self", persistence);
  await original.join("Singer", "room-a");
  expect(saved).toBe("room-a");

  const reloaded = setup();
  const restored = new RoomSessionController(reloaded.room, reloaded.audio, "self", persistence);
  await restored.restore("Singer");
  expect(reloaded.room.joinRoom).toHaveBeenCalledWith("room-a", "Singer");
  expect(reloaded.audio.joinVoiceSession).toHaveBeenCalledOnce();
  expect(restored.getRoom()?.code).toBe("room-a");
  await restored.leave();
  expect(saved).toBeNull();
});

it("cannot restore a stale join after the user leaves during renderer recovery", async () => {
  let saved: string | null = "room-a";
  const persistence = {
    load: () => saved,
    save: vi.fn((code: string) => { saved = code; }),
    clear: vi.fn(() => { saved = null; }),
  };
  const { room, audio } = setup();
  const pending = deferred<RoomStateDto>();
  room.joinRoom.mockReturnValue(pending.promise);
  const recovered = new RoomSessionController(room, audio, "self", persistence);
  const restoring = recovered.restore("Singer");
  const leaving = recovered.leave();
  pending.resolve(snapshot());
  await Promise.all([restoring, leaving]);
  expect(recovered.getRoom()).toBeNull();
  expect(saved).toBeNull();
  expect(audio.joinVoiceSession).not.toHaveBeenCalled();
});
