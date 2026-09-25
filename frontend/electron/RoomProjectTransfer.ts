import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { mkdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ipcChannels } from "./ipcChannels";
import type { IpcRegistrar } from "./TrustedIpc";
import { isSafePathComponent } from "./PathPolicy";

const projectUrl = (base: string, roomId: string, songId: string, revision: number): string =>
  `${base}/rooms/${encodeURIComponent(roomId)}/projects/${encodeURIComponent(songId)}/${revision}`;

export interface RoomProjectTransferProgress {
  transferId: string;
  direction: "upload" | "download";
  transferredBytes: number;
  totalBytes: number;
}

type Progress = (progress: RoomProjectTransferProgress) => void;

const progressStream = (
  transferId: string,
  direction: RoomProjectTransferProgress["direction"],
  totalBytes: number,
  progress?: Progress,
): Transform => {
  let transferredBytes = 0;
  let reportedBytes = -1;
  let reportedAt = -Infinity;
  const report = () => {
    reportedAt = performance.now();
    reportedBytes = transferredBytes;
    progress?.({ transferId, direction, transferredBytes, totalBytes });
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferredBytes += chunk.length;
      if (performance.now() - reportedAt >= 100) report();
      callback(null, chunk);
    },
    flush(callback) {
      if (reportedBytes !== transferredBytes) report();
      callback();
    },
  });
};

export const uploadRoomProject = async (
  base: string,
  roomId: string,
  participantId: string,
  songId: string,
  revision: number,
  filePath: string,
  transferId = `${songId}:${revision}:upload`,
  signal?: AbortSignal,
  progress?: Progress,
): Promise<void> => {
  const totalBytes = (await stat(filePath)).size;
  const source = createReadStream(filePath);
  const meter = progressStream(transferId, "upload", totalBytes, progress);
  const sending = pipeline(source, meter, { signal }).then(() => undefined, error => error);
  try {
    const response = await fetch(projectUrl(base, roomId, songId, revision), {
    method: "PUT",
    headers: { "X-Participant-Id": participantId, "Content-Type": "application/zip", "Content-Length": String(totalBytes) },
    body: Readable.toWeb(meter) as BodyInit,
    signal,
    duplex: "half"
  } as RequestInit & { duplex: "half" });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Room project upload failed (${response.status})`);
  } finally {
    source.destroy();
    meter.destroy();
    await sending;
  }
  const failure = await sending;
  if (failure) throw failure;
};

export const downloadRoomProject = async (
  base: string,
  roomId: string,
  participantId: string,
  songId: string,
  revision: number,
  targetPath: string,
  transferId = `${songId}:${revision}:download`,
  signal?: AbortSignal,
  progress?: Progress,
): Promise<string> => {
  const response = await fetch(projectUrl(base, roomId, songId, revision), {
    headers: { "X-Participant-Id": participantId },
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Room project download failed (${response.status})`);
  }
  // Electron's DOM stream types and Node's stream/web types are structurally
  // equivalent at runtime, but come from separate TypeScript declarations.
  const totalBytes = Number(response.headers.get("content-length") ?? 0);
  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await pipeline(
      Readable.fromWeb(response.body as never),
      progressStream(transferId, "download", totalBytes, progress),
      createWriteStream(targetPath),
      { signal },
    );
    return targetPath;
  } catch (error) {
    if (!response.body.locked) await response.body.cancel().catch(() => undefined);
    await rm(targetPath, { force: true });
    throw error;
  }
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
};

const requireProject = (raw: unknown) => {
  if (!raw || typeof raw !== "object") throw new TypeError("Room project request must be an object");
  const record = raw as Record<string, unknown>;
  if (typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new TypeError("revision must be a positive integer");
  }
  const songId = requireString(record.songId, "songId");
  if (!isSafePathComponent(songId)) throw new TypeError("Invalid project identity");
  return {
    roomId: requireString(record.roomId, "roomId"),
    participantId: requireString(record.participantId, "participantId"),
    songId,
    revision: record.revision,
    path: record.path,
    transferId: typeof record.transferId === "string"
      ? record.transferId
      : `${record.songId}:${record.revision}`,
  };
};

const requireBackendPath = (root: string, value: unknown): string => {
  const resolved = path.resolve(requireString(value, "path"));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TypeError("Path is outside the backend data directory");
  }
  return resolved;
};

export const registerRoomProjectTransferHandlers = (base: string, dataRoot: () => string, ipc: IpcRegistrar): void => {
  const transfers = new Map<string, { controller: AbortController; owner: WebContents; timer: ReturnType<typeof setTimeout> }>();
  const downloads = new Map<string, WebContents>();
  const owners = new WeakSet<WebContents>();
  const begin = (transferId: string, owner: WebContents): AbortController => {
    if (transfers.has(transferId)) throw new Error("Room project transfer is already active");
    if (transfers.size + downloads.size >= 32) throw new Error("Too many outstanding room project transfers");
    if (owner.isDestroyed()) throw new Error("Room project transfer owner is closed");
    if (!owners.has(owner)) {
      owners.add(owner);
      owner.once("destroyed", () => {
        for (const transfer of transfers.values()) if (transfer.owner === owner) transfer.controller.abort();
        for (const [file, fileOwner] of downloads) {
          if (fileOwner !== owner) continue;
          downloads.delete(file);
          void rm(file, { force: true }).catch(error => console.error("Room archive cleanup failed", error));
        }
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Room project transfer timed out")), 300_000);
    timer.unref?.();
    transfers.set(transferId, { controller, owner, timer });
    return controller;
  };
  const finish = (transferId: string) => {
    clearTimeout(transfers.get(transferId)?.timer);
    transfers.delete(transferId);
  };
  ipc.handle(ipcChannels.cancelRoomProjectTransfer, (_event, transferId: unknown) => {
    if (typeof transferId !== "string") throw new TypeError("transferId must be a string");
    return transfers.get(transferId)?.controller.abort();
  });
  ipc.handle(ipcChannels.releaseRoomProjectDownload, async (event, raw: unknown) => {
    const file = requireString(raw, "path");
    if (downloads.get(file) !== event.sender) throw new Error("Room archive is not owned by this renderer");
    await rm(file, { force: true });
    downloads.delete(file);
  });
  ipc.handle(ipcChannels.uploadRoomProject, async (event, raw: unknown) => {
    const project = requireProject(raw);
    const controller = begin(project.transferId, event.sender);
    try {
      await uploadRoomProject(base, project.roomId, project.participantId, project.songId, project.revision,
        requireBackendPath(dataRoot(), project.path), project.transferId, controller.signal,
        progress => { if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.roomProjectTransferProgress, progress); });
    } finally {
      finish(project.transferId);
    }
  });
  ipc.handle(ipcChannels.downloadRoomProject, async (event, raw: unknown) => {
    const project = requireProject(raw);
    const target = path.join(dataRoot(), "temp", "room-downloads",
      `${randomUUID()}.advoice.zip`);
    const controller = begin(project.transferId, event.sender);
    try {
      await downloadRoomProject(base, project.roomId, project.participantId, project.songId,
        project.revision, target, project.transferId, controller.signal,
        progress => { if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.roomProjectTransferProgress, progress); });
      if (controller.signal.aborted || event.sender.isDestroyed()) {
        await rm(target, { force: true });
        throw new Error("Room project transfer was cancelled");
      }
      downloads.set(target, event.sender);
      return target;
    } finally {
      finish(project.transferId);
    }
  });
};
