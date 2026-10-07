import { expect, it, vi } from "vitest";
import { KaraokeRecordingCoordinator } from "./KaraokeRecordingCoordinator";

it("does not start a recording after route cancellation overtakes disk preflight", async () => {
  let release!: (value: { storage: { free: number } }) => void;
  const backend = { diagnostics: vi.fn(() =>
    new Promise((resolve) => { release = resolve; })) };
  const recording = { start: vi.fn(), stop: vi.fn() };
  const audio = { stop: vi.fn() };
  const coordinator = new KaraokeRecordingCoordinator(
    backend as never, recording as never, audio as never,
  );
  const starting = coordinator.start({ id: "song" } as never,
    { sourceSeconds: 0, playbackRate: 1, keyShift: 0 });
  await vi.waitFor(() => expect(backend.diagnostics).toHaveBeenCalledOnce());
  coordinator.invalidate();
  release({ storage: { free: 10 ** 9 } });
  expect(await starting).toEqual({ kind: "cancelled" });
  expect(recording.start).not.toHaveBeenCalled();
});

it("stops native audio even when finalizing the take fails", async () => {
  const audio = { stop: vi.fn(async () => undefined) };
  const recording = { stop: vi.fn(async () => { throw new Error("save failed"); }) };
  const coordinator = new KaraokeRecordingCoordinator(
    { diagnostics: vi.fn() } as never, recording as never, audio as never,
  );
  expect(await coordinator.finish()).toEqual({ saved: false });
  expect(audio.stop).toHaveBeenCalledOnce();
});
