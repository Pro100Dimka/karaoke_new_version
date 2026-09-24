import { describe, expect, it, vi } from "vitest";
import { createLatestSnapshotQueue } from "./latestSnapshotQueue";

describe("latest room snapshot queue", () => {
  it("coalesces a burst without dropping the newest snapshot", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const handled: number[] = [];
    const handler = vi.fn(async (value: number) => {
      handled.push(value);
      if (value === 1) await firstBlocked;
    });
    const queue = createLatestSnapshotQueue(handler);

    const first = queue.push(1);
    void queue.push(2);
    void queue.push(3);
    releaseFirst();
    await first;
    await queue.idle();

    expect(handled).toEqual([1, 3]);
  });
});
