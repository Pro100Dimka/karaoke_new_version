import { describe, expect, it, vi } from "vitest";
import { prepareAndLaunchRoomSong } from "./roomSongLaunch";

describe("remote room song launch", () => {
  it("keeps the library visible while the project downloads and only starts the curtain before navigation", async () => {
    let finishDownload!: (path: string) => void;
    const download = vi.fn(() => new Promise<string>(resolve => { finishDownload = resolve; }));
    const events: string[] = [];
    const task = prepareAndLaunchRoomSong({
      download,
      importProject: vi.fn(async () => ({ id: "song" })),
      refresh: vi.fn(async () => { events.push("refresh"); }),
      markPlayed: vi.fn(() => { events.push("played"); }),
      beginTransition: vi.fn(() => { events.push("curtain"); }),
      waitForTransition: vi.fn(async () => { events.push("wait"); }),
      navigate: vi.fn(() => { events.push("navigate"); })
    });

    await Promise.resolve();
    expect(events).toEqual([]);
    finishDownload("D:/room/song.advoice.zip");
    await task;

    expect(events).toEqual(["refresh", "played", "curtain", "wait", "navigate"]);
  });
});
