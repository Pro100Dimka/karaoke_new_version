import { expect, it, vi } from "vitest";
import { recoverKaraokeAudio } from "./KaraokeRecovery";

it("stops recovery when the route ends during native preparation", async () => {
  let release!: () => void;
  let current = true;
  const audio = {
    health: vi.fn(async () => ({ status: "ready" })),
    prepareSong: vi.fn(() => new Promise<void>((resolve) => { release = resolve; })),
    setPlaybackRate: vi.fn(), setPitchShift: vi.fn(), seek: vi.fn(),
  };
  const recovery = recoverKaraokeAudio({
    audio, song: { id: "song" }, position: 12, speed: 1.2, key: 2,
    isCurrent: () => current,
  } as never);
  await vi.waitFor(() => expect(audio.prepareSong).toHaveBeenCalledOnce());
  current = false;
  release();
  expect(await recovery).toBe(false);
  expect(audio.setPlaybackRate).not.toHaveBeenCalled();
  expect(audio.seek).not.toHaveBeenCalled();
});
