import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ipcMain } from "electron";
import { ipcChannels } from "./ipcChannels";

const projectUrl = (base: string, roomId: string, songId: string, revision: number): string =>
  `${base}/rooms/${encodeURIComponent(roomId)}/projects/${encodeURIComponent(songId)}/${revision}`;

export const uploadRoomProject = async (
  base: string,
  roomId: string,
  participantId: string,
  songId: string,
  revision: number,
  filePath: string
): Promise<void> => {
  const body = Readable.toWeb(createReadStream(filePath));
  const response = await fetch(projectUrl(base, roomId, songId, revision), {
    method: "PUT",
    headers: { "X-Participant-Id": participantId, "Content-Type": "application/zip" },
    body: body as BodyInit,
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
  targetPath: string
): Promise<string> => {
  const response = await fetch(projectUrl(base, roomId, songId, revision), {
    headers: { "X-Participant-Id": participantId }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Room project download failed (${response.status})`);
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  // Electron's DOM stream types and Node's stream/web types are structurally
  // equivalent at runtime, but come from separate TypeScript declarations.
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(targetPath));
  return targetPath;
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
    path: record.path
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
  ipcMain.handle(ipcChannels.uploadRoomProject, async (_event, raw: unknown) => {
    const project = requireProject(raw);
    await uploadRoomProject(base, project.roomId, project.participantId, project.songId, project.revision,
      requireBackendPath(dataRoot(), project.path));
  });
  ipcMain.handle(ipcChannels.downloadRoomProject, async (_event, raw: unknown) => {
    const project = requireProject(raw);
    const target = path.join(dataRoot(), "temp", "room-downloads",
      `${project.songId}-r${project.revision}.advoice.zip`);
    return downloadRoomProject(base, project.roomId, project.participantId, project.songId, project.revision, target);
  });
};
