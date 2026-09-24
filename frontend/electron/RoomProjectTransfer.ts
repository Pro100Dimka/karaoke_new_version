import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ipcMain } from "electron";
import { ipcChannels } from "./ipcChannels";

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
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferredBytes += chunk.length;
      progress?.({ transferId, direction, transferredBytes, totalBytes });
      callback(null, chunk);
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
  const body = Readable.toWeb(
    createReadStream(filePath).pipe(progressStream(transferId, "upload", totalBytes, progress)),
  );
  const response = await fetch(projectUrl(base, roomId, songId, revision), {
    method: "PUT",
    headers: { "X-Participant-Id": participantId, "Content-Type": "application/zip", "Content-Length": String(totalBytes) },
    body: body as BodyInit,
    signal,
    duplex: "half"
  } as RequestInit & { duplex: "half" });
  if (!response.ok) throw new Error(`Room project upload failed (${response.status})`);
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
    throw new Error(`Room project download failed (${response.status})`);
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  // Electron's DOM stream types and Node's stream/web types are structurally
  // equivalent at runtime, but come from separate TypeScript declarations.
  const totalBytes = Number(response.headers.get("content-length") ?? 0);
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      progressStream(transferId, "download", totalBytes, progress),
      createWriteStream(targetPath),
      { signal },
    );
    return targetPath;
  } catch (error) {
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
  if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 1) {
    throw new TypeError("revision must be a positive integer");
  }
  return {
    roomId: requireString(record.roomId, "roomId"),
    participantId: requireString(record.participantId, "participantId"),
    songId: requireString(record.songId, "songId"),
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

export const registerRoomProjectTransferHandlers = (base: string, dataRoot: () => string): void => {
  const transfers = new Map<string, AbortController>();
  ipcMain.handle(ipcChannels.cancelRoomProjectTransfer, (_event, transferId: unknown) => {
    if (typeof transferId !== "string") throw new TypeError("transferId must be a string");
    return transfers.get(transferId)?.abort();
  });
  ipcMain.handle(ipcChannels.uploadRoomProject, async (event, raw: unknown) => {
    const project = requireProject(raw);
    const controller = new AbortController();
    transfers.set(project.transferId, controller);
    try {
      await uploadRoomProject(base, project.roomId, project.participantId, project.songId, project.revision,
        requireBackendPath(dataRoot(), project.path), project.transferId, controller.signal,
        progress => event.sender.send(ipcChannels.roomProjectTransferProgress, progress));
    } finally {
      transfers.delete(project.transferId);
    }
  });
  ipcMain.handle(ipcChannels.downloadRoomProject, async (event, raw: unknown) => {
    const project = requireProject(raw);
    const target = path.join(dataRoot(), "temp", "room-downloads",
      `${project.songId}-r${project.revision}.advoice.zip`);
    const controller = new AbortController();
    transfers.set(project.transferId, controller);
    try {
      return await downloadRoomProject(base, project.roomId, project.participantId, project.songId,
        project.revision, target, project.transferId, controller.signal,
        progress => event.sender.send(ipcChannels.roomProjectTransferProgress, progress));
    } finally {
      transfers.delete(project.transferId);
    }
  });
};
