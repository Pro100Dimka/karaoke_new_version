import type { ProjectImportDecision } from "../../contracts/clients";
import type { RoomStateDto } from "../../contracts/models";
import { toAppError } from "../../shared/errors";

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
  signal?: AbortSignal;
  cancel?: () => void;
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
  // A failed transfer keeps its failure (and a conflict, its choice) until the singer acts on it;
  // the room's snapshot knows only the last progress it heard.
  if (self?.readiness === "failed" && previous.transferError)
    return roomTransferFailure(snapshot, previous.transferConflict);
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

/**
 * Clears stale byte counters but preserves an actionable retry state. A conflict means this singer
 * already has a different copy of the song; it is never overwritten without their say.
 */
export const roomTransferFailure = (room: RoomStateDto, conflict = false): RoomStateDto => ({
  ...room,
  transferProgress: undefined,
  transferId: undefined,
  transferBytes: undefined,
  transferTotalBytes: undefined,
  transferError: true,
  transferConflict: conflict,
});

/** The import met a local project whose revision diverged from the host's (backend PackageConflict). */
export const isProjectConflict = (error: unknown): boolean => toAppError(error).code === "PackageConflict";

// Songs whose own diverging copy this singer agreed to replace with the host's version.
const replaceable = new Set<string>();

/** Records the singer's explicit choice to replace their own copy of this revision with the host's. */
export const allowRoomProjectReplacement = (songId: string, revision: number): void => {
  replaceable.add(`${songId}:${revision}`);
};

/**
 * How a room project is imported: an older local revision is updated, a diverging one only after
 * the singer chose to replace it (a silent overwrite is never made).
 */
export const roomImportDecision = (songId: string, revision: number): ProjectImportDecision =>
  replaceable.has(`${songId}:${revision}`) ? "AcceptDivergent" : "AcceptOlder";

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
    options.signal?.throwIfAborted();
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          download(request),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => { options.cancel?.(); reject(options.signal?.reason); };
            options.signal?.addEventListener("abort", onAbort, { once: true });
            timeout = setTimeout(
              () => { options.cancel?.(); reject(new Error("Room project download timed out before receiving data")); },
              attemptTimeoutMilliseconds,
            );
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      if (!projectIsStillPublishing(error) || attempt === attempts) throw error;
      await wait(intervalMilliseconds);
    }
  }
  throw new Error("Room project did not become available");
};
