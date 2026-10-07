import { expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";
import { RoomRecoveryCoordinator } from "./RoomRecoveryCoordinator";

const snapshot = (): RoomStateDto => ({
  code: "room-a", hostId: "host", role: "participant", playbackLocked: false,
  participants: [{ id: "self", name: "Self", role: "participant", self: true,
    connected: true, readiness: "ready", muted: false, volume: 1 }],
});

it("does not apply a snapshot that waited on AudioService after the session changed", async () => {
  let active = true;
  let current = snapshot();
  let deliver!: (room: RoomStateDto) => void;
  let complete!: () => void;
  const scope: RoomSessionScope = {
    code: "room-a", generation: 1, signal: new AbortController().signal,
    isCurrent: () => active, getRoom: () => active ? current : null,
    setSnapshot: vi.fn((room) => { if (!active) return false; current = room; return true; }),
    disconnect: vi.fn(() => { active = false; return true; }),
  };
  const ports = {
    room: { watchRoom: vi.fn((_code, onRoom) => { deliver = onRoom; return vi.fn(); }) },
    audio: { leaveVoiceSession: vi.fn(async () => undefined) },
    python: { listSongs: vi.fn(async () => []) },
    voice: { synchronize: vi.fn(() => new Promise<void>((resolve) => { complete = resolve; })) },
    project: { reconcileReadiness: vi.fn(async () => undefined) },
    launch: { selectionChanged: vi.fn(), recordPlaybackTransition: vi.fn(),
      observe: vi.fn(), stop: vi.fn() },
    notify: vi.fn(), chime: vi.fn(),
  };
  const recovery = new RoomRecoveryCoordinator(scope, ports);
  recovery.start();
  deliver({ ...snapshot(), serverClockOffsetMilliseconds: 23 });
  await vi.waitFor(() => expect(ports.voice.synchronize).toHaveBeenCalledOnce());
  active = false;
  complete();
  await Promise.resolve();
  expect(scope.setSnapshot).not.toHaveBeenCalled();
  expect(ports.python.listSongs).not.toHaveBeenCalled();
  recovery.stop();
});

it("resumes project reconciliation when Python becomes ready without another server event", async () => {
  let deliver!: (room: RoomStateDto) => void;
  let current: RoomStateDto = { ...snapshot(), songId: "song", revision: 1 };
  const scope: RoomSessionScope = {
    code: "room-a", generation: 1, signal: new AbortController().signal,
    isCurrent: () => true, getRoom: () => current,
    setSnapshot: (room) => { current = room; return true; }, disconnect: () => true,
  };
  const ports = {
    room: { watchRoom: vi.fn((_code, onRoom) => { deliver = onRoom; return vi.fn(); }) },
    audio: { leaveVoiceSession: vi.fn(async () => undefined) },
    python: { listSongs: vi.fn(async () => []) },
    voice: { synchronize: vi.fn(async () => undefined) },
    project: { reconcileReadiness: vi.fn(async () => undefined) },
    launch: { selectionChanged: vi.fn(), recordPlaybackTransition: vi.fn(),
      observe: vi.fn(), stop: vi.fn() },
    notify: vi.fn(), chime: vi.fn(),
  };
  const recovery = new RoomRecoveryCoordinator(scope, ports);
  recovery.start();
  deliver(current);
  await vi.waitFor(() => expect(ports.voice.synchronize).toHaveBeenCalledOnce());
  expect(ports.python.listSongs).not.toHaveBeenCalled();
  recovery.setPythonReady(true);
  await vi.waitFor(() => expect(ports.project.reconcileReadiness).toHaveBeenCalledOnce());
  recovery.stop();
});

it("cancels a pending launch when the Room Server disconnects", async () => {
  let disconnected!: (error: unknown) => void;
  let current = snapshot();
  const scope: RoomSessionScope = {
    code: "room-a", generation: 1, signal: new AbortController().signal,
    isCurrent: () => true, getRoom: () => current,
    setSnapshot: (room) => { current = room; return true; }, disconnect: () => true,
  };
  const launch = { selectionChanged: vi.fn(), recordPlaybackTransition: vi.fn(),
    observe: vi.fn(), stop: vi.fn() };
  const recovery = new RoomRecoveryCoordinator(scope, {
    room: { watchRoom: vi.fn((_code, _onRoom, onError) => {
      disconnected = onError; return vi.fn();
    }) },
    audio: { leaveVoiceSession: vi.fn(async () => undefined) },
    python: { listSongs: vi.fn(async () => []) },
    voice: { synchronize: vi.fn(async () => undefined) },
    project: { reconcileReadiness: vi.fn(async () => undefined) },
    launch, notify: vi.fn(), chime: vi.fn(),
  });
  recovery.start();
  disconnected(new Error("Room Server unavailable"));
  await vi.waitFor(() => expect(current.connectionStatus).toBe("reconnecting"));
  expect(launch.stop).toHaveBeenCalledOnce();
  recovery.stop();
});
