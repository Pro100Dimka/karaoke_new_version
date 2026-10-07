import { expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";
import { RoomRuntimeCoordinator } from "./RoomRuntimeCoordinator";

const snapshot = (code: string): RoomStateDto => ({
  code, hostId: "host", role: "host", participants: [], playbackLocked: false,
});

it("stops the previous room watcher before a new session can receive its late response", async () => {
  let scope: RoomSessionScope | null = null;
  const listeners = new Set<() => void>();
  const session = {
    getScope: () => scope,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const callbacks = new Map<string, (room: RoomStateDto) => void>();
  const stopped = vi.fn();
  const never = new Promise<never>(() => undefined);
  const ports = {
    room: {
      watchRoom: vi.fn((code: string, onRoom: (room: RoomStateDto) => void) => {
        callbacks.set(code, onRoom);
        return stopped;
      }),
      voiceLevels: vi.fn(() => never), setVoiceLatency: vi.fn(() => never),
      setRoomReadiness: vi.fn(() => never), publishLibrary: vi.fn(() => never),
      publishDiagnostics: vi.fn(async () => undefined),
    },
    audio: {
      roomLevels: vi.fn(() => never), roomTiming: vi.fn(() => never),
      joinVoiceSession: vi.fn(async () => undefined), leaveVoiceSession: vi.fn(async () => undefined),
      synchronizeRoomClock: vi.fn(async () => undefined),
      setRoomPlayoutDelay: vi.fn(async () => undefined),
      addRemoteParticipant: vi.fn(async () => undefined),
      removeRemoteParticipant: vi.fn(async () => undefined),
      playTestSound: vi.fn(async () => undefined),
      reconnectVoiceSession: vi.fn(async () => undefined),
      listDevices: vi.fn(async () => []), preferredConfiguration: vi.fn(() => ({ backend: "WASAPI Shared" })),
      diagnosticsDump: vi.fn(async () => ({})),
      microphoneEnabled: vi.fn(() => true), setMicrophoneEnabled: vi.fn(async () => undefined),
    },
    python: { listSongs: vi.fn(async () => []), importProject: vi.fn(() => never), exportProject: vi.fn(() => never) },
    desktop: { onRoomProjectTransferProgress: vi.fn(() => vi.fn()),
      downloadRoomProject: vi.fn(() => never), uploadRoomProject: vi.fn(() => never),
      cancelRoomProjectTransfer: vi.fn(async () => undefined),
      releaseRoomProjectDownload: vi.fn(async () => undefined) },
    copies: { get: vi.fn(), remember: vi.fn() }, participantId: "self",
  };
  const runtime = new RoomRuntimeCoordinator(session, ports as never);
  runtime.attach({ pathname: () => "/", navigate: vi.fn(), curtain: vi.fn(),
    notify: vi.fn(), chime: vi.fn() });
  const makeScope = (code: string) => {
    let active = true;
    const setSnapshot = vi.fn((_room: RoomStateDto) => active);
    return { lease: { code, generation: 1, signal: new AbortController().signal,
      isCurrent: () => active, getRoom: () => active ? snapshot(code) : null,
      setSnapshot, disconnect: () => { active = false; return true; } } as RoomSessionScope,
      invalidate: () => { active = false; }, setSnapshot };
  };
  const first = makeScope("room-a");
  scope = first.lease;
  listeners.forEach((listener) => listener());
  const oldCallback = callbacks.get("room-a");
  expect(oldCallback).toBeDefined();
  first.invalidate();
  const second = makeScope("room-b");
  scope = second.lease;
  listeners.forEach((listener) => listener());
  oldCallback?.(snapshot("room-a"));
  await Promise.resolve();
  expect(stopped).toHaveBeenCalledOnce();
  expect(first.setSnapshot).not.toHaveBeenCalled();
  expect(callbacks.has("room-b")).toBe(true);
  runtime.dispose();
});
