import { describe, expect, it, vi } from "vitest";
import { importOneByOne } from "./batchImport";

describe("importOneByOne", () => {
  it("adds every chosen file in the order it was picked, one at a time", async () => {
    const order: string[] = [];
    let running = 0;
    const importOne = vi.fn(async (path: string) => {
      running += 1;
      expect(running).toBe(1);
      order.push(path);
      await Promise.resolve();
      running -= 1;
    });

    const result = await importOneByOne(
      ["D:/a.mp3", "D:/b.flac", "D:/c.wav"],
      importOne,
    );

    expect(order).toEqual(["D:/a.mp3", "D:/b.flac", "D:/c.wav"]);
    expect(result).toEqual({ imported: 3, failed: [] });
  });

  it("keeps going past a file that fails and names it", async () => {
    const windowsPath = ["D:", "Music", "broken.mp3"].join("\\");
    const importOne = vi.fn(async (path: string) => {
      if (path === windowsPath) throw new Error("bad");
    });

    const result = await importOneByOne(
      ["D:/one.mp3", windowsPath, "D:/two.ogg"],
      importOne,
    );

    expect(importOne).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ imported: 2, failed: ["broken.mp3"] });
  });

  it("skips files that are not audio without trying to import them", async () => {
    const importOne = vi.fn(async () => undefined);

    const result = await importOneByOne(
      ["D:/cover.jpg", "D:/song.M4A"],
      importOne,
    );

    expect(importOne).toHaveBeenCalledOnce();
    expect(importOne).toHaveBeenCalledWith("D:/song.M4A");
    expect(result).toEqual({ imported: 1, failed: ["cover.jpg"] });
  });
});
