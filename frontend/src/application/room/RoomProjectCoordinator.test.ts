import { expect, it, vi } from "vitest";
import type { RoomStateDto, SongDto } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";
import { RoomProjectCoordinator } from "./RoomProjectCoordinator";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const setup = () => {
  let active = true;
  let room: RoomStateDto = {
    code: "room-a", hostId: "host", role: "participant", participants: [], playbackLocked: false,
  };
  let progress: (value: { transferId: string; direction: "download";
    transferredBytes: number; totalBytes: number }) => void = () => undefined;
  const scope: RoomSessionScope = {
    code: "room-a", generation: 1, signal: new AbortController().signal,
    isCurrent: () => active,
    getRoom: () => active ? room : null,
    setSnapshot: (snapshot) => {
      if (!active) return false;
      room = snapshot;
      return true;
    },
    disconnect: () => { active = false; return true; },
  };
  const services = {
    room: {
      setRoomReadiness: vi.fn(async () => room),
      publishLibrary: vi.fn(async () => room),
    },
    python: {
      importProject: vi.fn(async () => ({ id: "local-song" }) as SongDto),
      listSongs: vi.fn(async (): Promise<readonly SongDto[]> => []),
      exportProject: vi.fn(async () => "archive.zip"),
    },
    desktop: {
      downloadRoomProject: vi.fn(async () => "archive.zip"),
      cancelRoomProjectTransfer: vi.fn(async () => undefined),
      releaseRoomProjectDownload: vi.fn(async () => undefined),
      uploadRoomProject: vi.fn(async (_request: RoomProjectTransferRequest & { path: string }): Promise<void> => undefined),
      onRoomProjectTransferProgress: vi.fn((listener) => {
        progress = listener;
        return () => { progress = () => undefined; };
      }),
    },
    copies: { get: vi.fn(), remember: vi.fn() },
    participantId: "self",
    onFailure: vi.fn(),
  };
  return {
    scope, services, coordinator: new RoomProjectCoordinator(scope, services),
    leave: () => { active = false; },
    getRoom: () => room,
    setRoom: (value: RoomStateDto) => { room = value; },
    progress: (value: { transferId: string; direction: "download";
      transferredBytes: number; totalBytes: number }) => progress(value),
  };
};

it("cancels transfer on leave and releases a late archive without importing it", async () => {
  const { coordinator, services, leave, getRoom } = setup();
  const downloading = deferred<string>();
  services.desktop.downloadRoomProject.mockReturnValue(downloading.promise);
  const preparing = coordinator.prepare("song", 1);
  await vi.waitFor(() => expect(services.desktop.downloadRoomProject).toHaveBeenCalledOnce());

  const beforeLeave = getRoom();
  leave();
  coordinator.cancel();
  downloading.resolve("late.zip");
  await preparing;

  expect(services.desktop.cancelRoomProjectTransfer).toHaveBeenCalledOnce();
  expect(services.desktop.releaseRoomProjectDownload).toHaveBeenCalledWith("late.zip");
  expect(services.python.importProject).not.toHaveBeenCalled();
  expect(getRoom()).toBe(beforeLeave);
});

it("keeps replacement consent inside this room's project coordinator", async () => {
  const first = setup();
  first.setRoom({ ...first.getRoom(), songId: "song", revision: 2 });
  await first.coordinator.replaceProject();
  expect(first.services.room.setRoomReadiness).toHaveBeenCalledWith("room-a", "MissingSong");
  expect(first.coordinator.importDecision("song", 2)).toBe("AcceptDivergent");
  const nextSession = setup();
  expect(nextSession.coordinator.importDecision("song", 2)).toBe("AcceptOlder");
});

it("does not restore an old selection when its retry response arrives late", async () => {
  const { coordinator, services, getRoom, setRoom } = setup();
  setRoom({ ...getRoom(), songId: "old", revision: 1 });
  const pending = deferred<RoomStateDto>();
  services.room.setRoomReadiness.mockReturnValue(pending.promise);
  const retry = coordinator.retry();
  setRoom({ ...getRoom(), songId: "new", revision: 2 });
  pending.resolve({ ...getRoom(), songId: "old", revision: 1 });
  await retry;
  expect(getRoom().songId).toBe("new");
});

it("records partial import failure, releases the archive, and allows explicit retry", async () => {
  const { coordinator, services, getRoom } = setup();
  services.python.importProject.mockRejectedValueOnce(new Error("invalid archive"));

  await coordinator.prepare("song", 1);
  expect(services.room.setRoomReadiness).toHaveBeenCalledWith("room-a", "Failed");
  expect(getRoom().transferError).toBe(true);
  expect(services.desktop.releaseRoomProjectDownload).toHaveBeenCalledWith("archive.zip");

  await coordinator.prepare("song", 1);
  expect(services.python.importProject).toHaveBeenCalledTimes(2);
  expect(services.copies.remember).toHaveBeenCalledWith("song", 1, "local-song");
});

it("coalesces byte progress and ignores an old readiness response after import begins", async () => {
  const { coordinator, services, setRoom, getRoom, progress } = setup();
  let complete!: (value: RoomStateDto) => void;
  services.room.setRoomReadiness.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  setRoom({ ...getRoom(), transferId: "transfer", transferProgress: 10 });
  coordinator.start();
  for (let transferredBytes = 1; transferredBytes <= 50; transferredBytes += 1)
    progress({ transferId: "transfer", direction: "download", transferredBytes, totalBytes: 100 });
  await vi.waitFor(() => expect(services.room.setRoomReadiness).toHaveBeenCalledOnce());
  setRoom({ ...getRoom(), transferProgress: 70 });
  complete(getRoom());
  await vi.waitFor(() => expect(getRoom().transferProgress).toBe(70));
  coordinator.stop();
});

it("cancels an in-flight project upload when the session stops", async () => {
  const { coordinator, services, setRoom, getRoom } = setup();
  setRoom({ ...getRoom(), songId: "song", revision: 1 });
  services.python.listSongs.mockResolvedValue([
    { id: "song", activeRevision: 1, status: "ready" } as SongDto,
  ]);
  let finish!: () => void;
  services.desktop.uploadRoomProject.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));

  coordinator.start();
  coordinator.setPythonReady(true);
  await vi.waitFor(() => expect(services.desktop.uploadRoomProject).toHaveBeenCalledOnce());
  const transferId = services.desktop.uploadRoomProject.mock.calls[0]?.[0].transferId;
  coordinator.stop();
  expect(services.desktop.cancelRoomProjectTransfer).toHaveBeenCalledWith(transferId);
  finish();
});

it("reconciles local readiness without declaring the server room playable early", async () => {
  const { coordinator, services, getRoom, setRoom } = setup();
  setRoom({ ...getRoom(), songId: "song", revision: 1, participants: [
    { id: "self", name: "Self", role: "participant", self: true,
      connected: true, readiness: "missing", muted: false, volume: 1 },
  ] });
  await coordinator.reconcileReadiness(getRoom(), [
    { id: "song", activeRevision: 1, status: "ready" } as SongDto,
  ]);
  expect(services.room.setRoomReadiness).toHaveBeenCalledWith("room-a", "Preparing");
  expect(services.room.setRoomReadiness).not.toHaveBeenCalledWith("room-a", "Ready");
});
