import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const markerPath = (projectRoot) => {
  const project = path.resolve(projectRoot).toLowerCase();
  const id = createHash("sha256").update(project).digest("hex").slice(0, 16);
  return path.join(tmpdir(), `ad-voice-running-${id}.json`);
};

const markerPid = (projectRoot) => {
  try {
    const value = JSON.parse(readFileSync(markerPath(projectRoot), "utf8"));
    return Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null;
  } catch {
    return null;
  }
};

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

export const runningAppPid = (projectRoot) => {
  const file = markerPath(projectRoot);
  const pid = markerPid(projectRoot);
  if (pid && processIsAlive(pid)) return pid;
  if (existsSync(file)) try { unlinkSync(file); } catch {}
  return null;
};

export const claimRunningApp = (projectRoot, pid) => {
  if (runningAppPid(projectRoot)) return false;
  writeFileSync(markerPath(projectRoot), JSON.stringify({ pid }));
  return true;
};

export const transferRunningApp = (projectRoot, ownerPid, nextPid) => {
  if (markerPid(projectRoot) !== ownerPid) return false;
  writeFileSync(markerPath(projectRoot), JSON.stringify({ pid: nextPid }));
  return true;
};

export const releaseRunningApp = (projectRoot, ownerPid) => {
  const file = markerPath(projectRoot);
  if (markerPid(projectRoot) !== ownerPid) return;
  try { unlinkSync(file); } catch {}
};
