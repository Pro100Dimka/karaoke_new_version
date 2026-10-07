import { expect, it, vi } from "vitest";
import { RoomPlaybackSynchronizer } from "./RoomPlaybackSynchronizer";
import { synchronizeRoomPlayback } from "./roomPlayback";

vi.mock("./roomPlayback", () => ({
  roomPlaybackSnapshotKey: (room: { code: string }) => room.code,
  synchronizeRoomPlayback: vi.fn(async () => undefined),
}));

it("cannot apply room A's late native snapshot after room B replaces it", async () => {
  let releaseFirst!: (snapshot: { state: string; positionSeconds: number }) => void;
  const snapshot = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
    .mockResolvedValue({ state: "ready", positionSeconds: 0 });
  const audio = { snapshot, pause: vi.fn() };
  const sync = new RoomPlaybackSynchronizer(audio as never);
  sync.receive({ room: { code: "A", participants: [] }, ready: true, stateKind: "ready",
    onEvent: vi.fn(), onFinished: vi.fn(), onFailure: vi.fn() } as never);
  const stopA = sync.activate();
  await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
  stopA();
  sync.receive({ room: { code: "B", participants: [] }, ready: true, stateKind: "ready",
    onEvent: vi.fn(), onFinished: vi.fn(), onFailure: vi.fn() } as never);
  const stopB = sync.activate();
  releaseFirst({ state: "ready", positionSeconds: 0 });
  await vi.waitFor(() => expect(synchronizeRoomPlayback).toHaveBeenCalledOnce());
  expect(vi.mocked(synchronizeRoomPlayback).mock.calls[0]?.[0].code).toBe("B");
  stopB();
});
