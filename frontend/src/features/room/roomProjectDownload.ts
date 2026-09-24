import type { RoomStateDto } from "../../contracts/models";

export interface RoomProjectDownloadRequest {
  roomId: string;
  participantId: string;
  songId: string;
  revision: number;
  transferId?: string;
}

interface DownloadOptions {
  attempts?: number;
  intervalMilliseconds?: number;
}

const transferErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return typeof error === "string" ? error : "";
};

const projectIsStillPublishing = (error: unknown): boolean =>
  /room project download failed \(404\)/i.test(transferErrorMessage(error));

/** Clears stale byte counters but preserves an actionable retry state. */
export const roomTransferFailure = (room: RoomStateDto): RoomStateDto => ({
  ...room,
  transferProgress: undefined,
  transferId: undefined,
  transferBytes: undefined,
  transferTotalBytes: undefined,
  transferError: true,
});

/** A library item is advertised before its archive necessarily finishes exporting on its owner. */
export const downloadAvailableRoomProject = async (
  download: (request: RoomProjectDownloadRequest) => Promise<string>,
  wait: (milliseconds: number) => Promise<unknown>,
  request: RoomProjectDownloadRequest,
  options: DownloadOptions = {}
): Promise<string> => {
  const attempts = Math.max(1, options.attempts ?? 240);
  const intervalMilliseconds = Math.max(0, options.intervalMilliseconds ?? 500);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await download(request);
    } catch (error) {
      if (!projectIsStillPublishing(error) || attempt === attempts) throw error;
      await wait(intervalMilliseconds);
    }
  }
  throw new Error("Room project did not become available");
};
