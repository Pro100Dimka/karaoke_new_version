import { describe, expect, it, vi } from "vitest";
import { downloadAvailableRoomProject, roomTransferFailure } from "./roomProjectDownload";

describe("room project download", () => {
  it("keeps the failed transfer visible so the user can retry it", () => {
    expect(roomTransferFailure({
      code: "room",
      hostId: "host",
      role: "participant",
      participants: [],
      playbackLocked: false,
      transferId: "transfer-1",
      transferProgress: 42,
      transferBytes: 420,
      transferTotalBytes: 1_000,
    })).toMatchObject({
      transferId: undefined,
      transferProgress: undefined,
      transferBytes: undefined,
      transferTotalBytes: undefined,
      transferError: true,
    });
  });

  it("waits for the owner to finish publishing a selected project", async () => {
    const download = vi.fn()
      .mockRejectedValueOnce(new Error("Room project download failed (404)"))
      .mockRejectedValueOnce(new Error("Room project download failed (404)"))
      .mockResolvedValue("D:/room/song.advoice.zip");
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(downloadAvailableRoomProject(download, wait, {
      roomId: "room", participantId: "guest", songId: "song", revision: 2
    }, { attempts: 4, intervalMilliseconds: 1 })).resolves.toBe("D:/room/song.advoice.zip");

    expect(download).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("does not hide a permanent transfer failure behind retries", async () => {
    const download = vi.fn().mockRejectedValue(new Error("Room project download failed (500)"));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(downloadAvailableRoomProject(download, wait, {
      roomId: "room", participantId: "guest", songId: "song", revision: 2
    })).rejects.toThrow("500");
    expect(download).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
