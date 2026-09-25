import { describe, expect, it, vi } from "vitest";
import { downloadAvailableRoomProject, preserveLocalRoomTransfer, roomTransferFailure } from "./roomProjectDownload";

describe("room project download", () => {
  it("cancels the underlying IPC transfer on timeout", async () => {
    const cancel = vi.fn();
    await expect(downloadAvailableRoomProject(() => new Promise(() => {}), vi.fn(), {
      roomId: "room", participantId: "guest", songId: "song", revision: 1,
    }, { attemptTimeoutMilliseconds: 1, cancel })).rejects.toThrow("timed out");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("stops retries when the room lifetime ends", async () => {
    const controller = new AbortController();
    const download = vi.fn().mockRejectedValue(new Error("Room project download failed (404)"));
    const wait = vi.fn(async () => { controller.abort(); });
    await expect(downloadAvailableRoomProject(download, wait, {
      roomId: "room", participantId: "guest", songId: "song", revision: 1,
    }, { attempts: 3, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(download).toHaveBeenCalledOnce();
  });
  it("preserves local byte progress when an authoritative room snapshot arrives mid-download", () => {
    const previous = {
      code: "room",
      hostId: "host",
      role: "participant" as const,
      participants: [{ id: "guest", name: "Guest", role: "participant" as const, connected: true,
        self: true, readiness: "downloading" as const, transferProgress: 10,
        muted: false, speakingLevel: 0, volume: 1 }],
      playbackLocked: false,
      transferId: "transfer-1",
      transferProgress: 37,
      transferBytes: 27,
      transferTotalBytes: 100,
      transferError: false,
    };
    const snapshot = {
      ...previous,
      transferId: undefined,
      transferProgress: 10,
      transferBytes: undefined,
      transferTotalBytes: undefined,
    };

    expect(preserveLocalRoomTransfer(previous, snapshot)).toMatchObject({
      transferId: "transfer-1",
      transferProgress: 37,
      transferBytes: 27,
      transferTotalBytes: 100,
      transferError: false,
    });
  });

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

  it("treats an Electron IPC 404 payload as publishing progress instead of a network failure", async () => {
    const download = vi.fn()
      .mockRejectedValueOnce({ message: "Error invoking remote method: Room project download failed (404)" })
      .mockRejectedValueOnce({ message: "Room project download failed (404)" })
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

  it("fails a transfer attempt that never produces bytes instead of staying at ten percent forever", async () => {
    const download = vi.fn(() => new Promise<string>(() => undefined));

    await expect(downloadAvailableRoomProject(download, vi.fn(), {
      roomId: "room", participantId: "guest", songId: "song", revision: 2
    }, { attempts: 1, attemptTimeoutMilliseconds: 1 })).rejects.toThrow("timed out");
  });
});
