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
  attemptTimeoutMilliseconds?: number;
}

const activeTransferReadiness = new Set<RoomStateDto["participants"][number]["readiness"]>([
  "downloading",
  "verifying",
  "audio",
]);

/** Room snapshots are authoritative for shared state, but do not contain renderer-local byte counters. */
export const preserveLocalRoomTransfer = (
  previous: RoomStateDto,
  snapshot: RoomStateDto,
): RoomStateDto => {
  const self = snapshot.participants.find(participant => participant.self);
  if (!previous.transferId || !self || !activeTransferReadiness.has(self.readiness)) return snapshot;
  return {
    ...snapshot,
    transferId: previous.transferId,
    transferProgress: Math.max(previous.transferProgress ?? 0, snapshot.transferProgress ?? 0),
    transferBytes: previous.transferBytes,
    transferTotalBytes: previous.transferTotalBytes,
    transferError: previous.transferError,
  };
};

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
  const attemptTimeoutMilliseconds = Math.max(1, options.attemptTimeoutMilliseconds ?? 300_000);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          download(request),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Room project download timed out before receiving data")),
              attemptTimeoutMilliseconds,
            );
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    } catch (error) {
      if (!projectIsStillPublishing(error) || attempt === attempts) throw error;
      await wait(intervalMilliseconds);
    }
  }
  throw new Error("Room project did not become available");
};
