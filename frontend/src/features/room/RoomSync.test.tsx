import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RoomStateDto } from "../../contracts/models";

const mocks = vi.hoisted(() => ({
  room: null as RoomStateDto | null,
  snapshot: (_room: RoomStateDto) => {},
  setRoom: vi.fn(), notify: vi.fn(), navigate: vi.fn(), text: (key: string) => key,
  download: vi.fn(), release: vi.fn(), cancel: vi.fn(), importProject: vi.fn(), readiness: vi.fn(),
  listSongs: vi.fn(), exportProject: vi.fn(), upload: vi.fn(),
  reconcile: vi.fn(), addRemote: vi.fn(), navigation: vi.fn(), synchronizeClock: vi.fn(),
  progress: (_progress: { transferId: string; direction: "download"; transferredBytes: number; totalBytes: number }) => {},
}));
vi.mock("../../app/AppContext", () => ({ useApp: () => ({ room: mocks.room, setRoom: mocks.setRoom }) }));
vi.mock("../../app/ServicesContext", () => ({ useServices: () => ({ python: { kind: "ready" } }) }));
vi.mock("../../app/NotificationsProvider", () => ({ useNotify: () => mocks.notify }));
vi.mock("../../i18n/useText", () => ({ useText: () => mocks.text }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate, useLocation: () => ({ pathname: "/library" }) }));
vi.mock("../../services/audioClient", () => ({ audioClient: {
  roomLevels: () => new Promise(() => {}), roomTiming: () => new Promise(() => {}),
  addRemoteParticipant: mocks.addRemote, removeRemoteParticipant: vi.fn(), leaveVoiceSession: vi.fn(),
  synchronizeRoomClock: mocks.synchronizeClock,
} }));
vi.mock("../../services/pythonClient", () => ({ pythonClient: {
  listSongs: mocks.listSongs, importProject: mocks.importProject, exportProject: mocks.exportProject,
} }));
vi.mock("../../services/desktopClient", () => ({ desktopClient: {
  downloadRoomProject: mocks.download, releaseRoomProjectDownload: mocks.release,
  uploadRoomProject: mocks.upload,
  cancelRoomProjectTransfer: mocks.cancel,
  onRoomProjectTransferProgress: (callback: typeof mocks.progress) => { mocks.progress = callback; return () => {}; },
} }));
vi.mock("../../services/roomClient", () => ({ roomClient: {
  watchRoom: (_code: string, callback: typeof mocks.snapshot) => { mocks.snapshot = callback; return () => {}; },
  publishLibrary: async () => mocks.room, setRoomReadiness: mocks.readiness,
} }));
vi.mock("./roomModel", async importOriginal => ({
  ...await importOriginal<typeof import("./roomModel")>(),
  hasCurrentParticipant: () => true, diffParticipants: () => ({ joined: [], left: [] }),
  reconcileRemoteParticipants: mocks.reconcile,
  restoreRoomVoiceAfterReconnect: () => false,
}));
vi.mock("./roomNavigation", () => ({ roomKaraokeNavigation: mocks.navigation }));
import { RoomSync } from "./RoomSync";

const room = (code = "room", songId = "song"): RoomStateDto => ({
  code, songId, revision: 1, role: "participant", hostId: "host", playbackLocked: false, participants: [],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.room = room();
  mocks.setRoom.mockImplementation(value => { mocks.room = value; });
  mocks.readiness.mockImplementation(async code => ({ ...mocks.room, code }));
  mocks.cancel.mockResolvedValue(undefined);
  mocks.release.mockResolvedValue(undefined);
  mocks.importProject.mockResolvedValue({ id: "song" });
  mocks.reconcile.mockReturnValue({ add: [], remove: [] });
  mocks.listSongs.mockResolvedValue([]);
  mocks.exportProject.mockResolvedValue("archive.zip");
  mocks.navigation.mockImplementation((snapshot: RoomStateDto, _path: string, _library: unknown, imported?: string) => ({
    kind: imported ? "stay" : "download", songId: snapshot.songId, revision: snapshot.revision,
  }));
});
afterEach(cleanup);

it("refreshes the native voice clock from authoritative room clock samples", async () => {
  render(<RoomSync />);
  await act(async () => mocks.snapshot({ ...room(), serverClockOffsetMilliseconds: 123456789 }));
  await waitFor(() => expect(mocks.synchronizeClock).toHaveBeenCalledWith(123456789));
});

it.each(["missing", "failed", "disconnected"] as const)("prepares an existing project after joining with %s readiness", async readiness => {
  const { roomKaraokeNavigation } = await vi.importActual<typeof import("./roomNavigation")>("./roomNavigation");
  mocks.navigation.mockImplementation(roomKaraokeNavigation);
  mocks.room = { ...room(), playbackState: "playing", participants: [{
    id: "self", name: "Self", role: "participant", self: true, connected: true,
    readiness, muted: false, volume: 1, speakingLevel: 0,
  }] };
  mocks.listSongs.mockResolvedValue([{ id: "song", activeRevision: 1, status: "ready" }]);
  mocks.readiness.mockImplementation(async () => ({ ...mocks.room,
    participants: mocks.room?.participants.map(person => ({ ...person, readiness: "audio" })),
  }));
  render(<RoomSync />);
  act(() => mocks.snapshot(mocks.room ?? room()));
  await waitFor(() => expect(mocks.readiness).toHaveBeenCalledWith("room", "Preparing"));
  expect(mocks.readiness).not.toHaveBeenCalledWith("room", "Ready");
  expect(mocks.download).not.toHaveBeenCalled();
  await act(async () => mocks.snapshot(mocks.room ?? room()));
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/karaoke/song", { state: { mode: "RoomPrepared" } }));
});

it("cancels an in-flight project upload when leaving the room", async () => {
  mocks.listSongs.mockResolvedValue([{ id: "song", activeRevision: 1, status: "ready" }]);
  const uploading = deferred<void>();
  mocks.upload.mockReturnValue(uploading.promise);
  const view = render(<RoomSync />);
  await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
  const transferId = mocks.upload.mock.calls[0]?.[0].transferId;
  expect(typeof transferId).toBe("string");
  view.unmount();
  expect(mocks.cancel).toHaveBeenCalledWith(transferId);
  await act(async () => { uploading.resolve(); });
});

it("coalesces download progress requests and ignores late responses after importing starts", async () => {
  const response = deferred<RoomStateDto>();
  mocks.room = { ...room(), transferId: "transfer", transferProgress: 10 };
  mocks.readiness.mockReturnValue(response.promise);
  const view = render(<RoomSync />);
  await act(async () => {});
  act(() => {
    for (let transferredBytes = 1; transferredBytes <= 100; ++transferredBytes)
      mocks.progress({ transferId: "transfer", direction: "download", transferredBytes, totalBytes: 100 });
  });
  expect(mocks.readiness).toHaveBeenCalledOnce();
  mocks.room = { ...mocks.room!, transferProgress: 70 };
  view.rerender(<RoomSync />);
  await act(async () => { response.resolve(room()); });
  expect(mocks.room?.transferProgress).toBe(70);
  expect(mocks.readiness).toHaveBeenCalledOnce();
});

it("discards a room snapshot which was waiting for native peer registration during leave", async () => {
  const added = deferred<void>();
  mocks.addRemote.mockReturnValue(added.promise);
  mocks.reconcile.mockReturnValue({ add: ["remote"], remove: [] });
  const view = render(<RoomSync />);
  act(() => mocks.snapshot(room()));
  await waitFor(() => expect(mocks.addRemote).toHaveBeenCalledOnce());
  mocks.room = null;
  view.rerender(<RoomSync />);
  await act(async () => { added.resolve(); });
  expect(mocks.room).toBeNull();
});

it("cancels a download on leave and disposes a late result without importing or resurrecting the room", async () => {
  const download = deferred<string>();
  mocks.download.mockReturnValue(download.promise);
  const view = render(<RoomSync />);
  act(() => mocks.snapshot(room()));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  mocks.room = null;
  view.rerender(<RoomSync />);
  await act(async () => { download.resolve("archive.zip"); });
  expect(mocks.cancel).toHaveBeenCalledOnce();
  expect(mocks.release).toHaveBeenCalledWith("archive.zip");
  expect(mocks.importProject).not.toHaveBeenCalled();
  expect(mocks.room).toBeNull();
});

it("does not publish or navigate an old room when an in-flight import finishes", async () => {
  const imported = deferred<{ id: string }>();
  mocks.download.mockResolvedValue("archive.zip");
  mocks.importProject.mockReturnValue(imported.promise);
  const view = render(<RoomSync />);
  act(() => mocks.snapshot(room()));
  await waitFor(() => expect(mocks.importProject).toHaveBeenCalledOnce());
  mocks.room = room("new-room", "new-song");
  view.rerender(<RoomSync />);
  await act(async () => { imported.resolve({ id: "song" }); });
  expect(mocks.readiness).not.toHaveBeenCalledWith("room", "Preparing", 95);
  expect(mocks.release).toHaveBeenCalledWith("archive.zip");
  expect(mocks.room?.code).toBe("new-room");
});

it("releases a downloaded archive even when import fails", async () => {
  mocks.download.mockResolvedValue("archive.zip");
  mocks.importProject.mockRejectedValue(new Error("invalid archive"));
  render(<RoomSync />);
  act(() => mocks.snapshot(room()));
  await waitFor(() => expect(mocks.importProject).toHaveBeenCalledOnce());
  await waitFor(() => expect(mocks.release).toHaveBeenCalledWith("archive.zip"));
});

it("cancels the previous song transfer as soon as a newer selection arrives", async () => {
  const download = deferred<string>();
  mocks.download.mockImplementation(request => request.songId === "song" ? download.promise : new Promise(() => {}));
  render(<RoomSync />);
  act(() => mocks.snapshot(room()));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
  act(() => mocks.snapshot(room("room", "new-song")));
  await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2));
  await act(async () => { download.resolve("archive.zip"); });
  expect(mocks.cancel).toHaveBeenCalled();
  expect(mocks.importProject).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledWith("archive.zip");
});
