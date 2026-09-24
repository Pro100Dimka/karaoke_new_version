import { describe, expect, it, vi } from "vitest";
import { createSingleFlight } from "./performanceFinish";

describe("room performance finalization", () => {
  it("coalesces simultaneous Stop and ClearSong events so recording analysis is not lost", async () => {
    let release!: () => void;
    const work = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const finish = createSingleFlight(work);

    const stopped = finish();
    const cleared = finish();
    expect(work).toHaveBeenCalledOnce();
    expect(cleared).toBe(stopped);
    release();
    await Promise.all([stopped, cleared]);
  });
});
