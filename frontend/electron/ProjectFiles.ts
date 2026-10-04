import { shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BackendEndpoint } from "./BackendEndpoint";
import { ipcChannels } from "./ipcChannels";
import { isSafePathComponent } from "./PathPolicy";
import { requireNumber, requireObject, requireString } from "./RequestValidation";
import type { IpcRegistrar } from "./TrustedIpc";
import { inspectWave } from "./WavFile";
import { waveformPeaks } from "./WavPeaks";

/**
 * A song project's files on disk: its revision folder, the artifacts its manifest names (kept inside
 * that folder), and the renderer's requests about them. The renderer names songs and recordings,
 * never paths, so it cannot reach a file outside the backend's data.
 */
export const registerProjectFileHandlers = (
  dataRoot: () => string,
  backend: BackendEndpoint,
  ipc: IpcRegistrar,
): void => {
  const projectRevisionRoot = (songId: string, revision: number): string => {
    if (
      !isSafePathComponent(songId) ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    ) {
      throw new TypeError("Invalid project identity");
    }
    return path.join(
      dataRoot(),
      "songs",
      songId,
      "revisions",
      String(revision),
    );
  };

  const projectArtifacts = (
    songId: string,
    revision: number,
  ): { instrumental: string; vocals?: string; melody?: string; lyricsSync?: string } => {
    const revisionRoot = projectRevisionRoot(songId, revision);
    const manifestPath = path.join(revisionRoot, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      artifacts?: unknown;
    };
    if (!Array.isArray(manifest.artifacts))
      throw new Error("Project manifest has no artifacts");
    const byName = new Map<string, string>();
    for (const item of manifest.artifacts) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (
        typeof record.logicalName !== "string" ||
        typeof record.relativePath !== "string"
      )
        continue;
      const resolved = path.resolve(revisionRoot, record.relativePath);
      const relative = path.relative(revisionRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Project artifact escapes revision root");
      byName.set(record.logicalName, resolved);
    }
    const instrumental = byName.get("instrumental");
    if (!instrumental) throw new Error("Instrumental artifact is missing");
    return {
      instrumental,
      vocals: byName.get("referenceVocal"),
      melody: byName.get("melody"),
      lyricsSync: byName.get("lyricsSync"),
    };
  };

  ipc.handle(ipcChannels.resolveProjectArtifacts, (_event, raw: unknown) => {
    const record = requireObject(raw, "Project request");
    return projectArtifacts(requireString(record.songId, "songId"), requireNumber(record.revision, "revision"));
  });

  // Peaks of the instrumental for the karaoke waveform; computed here because the renderer never decodes audio.
  ipc.handle(ipcChannels.waveformPeaks, (_event, raw: unknown) => {
    const record = requireObject(raw, "Waveform request");
    const { instrumental } = projectArtifacts(requireString(record.songId, "songId"), requireNumber(record.revision, "revision"));
    return waveformPeaks(instrumental, requireNumber(record.bins, "bins"));
  });

  // Peaks of a saved take: the backend names the file, so the renderer never passes a path.
  ipc.handle(ipcChannels.recordingPeaks, async (_event, raw: unknown) => {
    const record = requireObject(raw, "Recording request");
    const bins = requireNumber(record.bins, "bins");
    const response = await backend.request(`/recordings/${encodeURIComponent(requireString(record.recordingId, "recordingId"))}`);
    if (!response.ok) throw new Error(`Recording lookup failed: HTTP ${response.status}`);
    const { filePath } = response.body as { filePath?: unknown };
    try {
      return await waveformPeaks(requireString(filePath, "filePath"), bins);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  });

  ipc.handle(ipcChannels.revealProject, (_event, raw: unknown) => {
    const record = requireObject(raw, "Project request");
    const root = projectRevisionRoot(requireString(record.songId, "songId"), requireNumber(record.revision, "revision"));
    shell.showItemInFolder(path.join(root, "manifest.json"));
  });
  ipc.handle(ipcChannels.inspectWave, (_event, value: unknown) =>
    inspectWave(requireString(value, "path")),
  );
};
