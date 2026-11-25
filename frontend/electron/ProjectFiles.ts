import { shell, type WebContents } from 'electron';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { BackendEndpoint } from './BackendEndpoint';
import { ipcChannels } from './ipcChannels';
import { isSafePathComponent } from './PathPolicy';
import {
  requireNumber,
  requireObject,
  requireString,
} from './RequestValidation';
import type { IpcRegistrar } from './TrustedIpc';
import { inspectWave } from './WavFile';
import { createPeaksService } from './PeaksService';

/**
 * A song project's files on disk: its revision folder, the artifacts its manifest names (kept inside
 * that folder), and the renderer's requests about them. The renderer names songs and recordings,
 * never paths, so it cannot reach a file outside the backend's data.
 */
export const registerProjectFileHandlers = (
  dataRoot: () => string,
  backend: BackendEndpoint,
  ipc: IpcRegistrar,
  // Off the main thread and remembered per file: opening a song's takes never freezes the windows.
  waveformPeaks = createPeaksService(),
): void => {
  const requests = new WeakMap<WebContents, Map<string, AbortController>>();
  const waveformRequest = async <T>(
    owner: WebContents,
    record: Record<string, unknown>,
    read: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (record.requestId === undefined) return read();
    const id = requireString(record.requestId, 'waveform request id');
    if (!id || id.length > 128)
      throw new TypeError('Invalid waveform request id');
    let owned = requests.get(owner);
    if (!owned) {
      owned = new Map();
      requests.set(owner, owned);
      const active = owned;
      const release = () => {
        for (const controller of active.values()) controller.abort();
        active.clear();
      };
      owner.once('destroyed', release);
      owner.on('render-process-gone', release);
      owner.on('did-start-navigation', (navigation) => {
        if (navigation.isMainFrame && !navigation.isSameDocument) release();
      });
    }
    if (owner.isDestroyed()) throw new Error('Waveform owner is closed');
    if (owned.has(id) || owned.size >= 256)
      throw new Error('Too many or duplicate waveform requests');
    const controller = new AbortController();
    owned.set(id, controller);
    try {
      const result = await read(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      if (owned.get(id) === controller) owned.delete(id);
    }
  };
  ipc.handle(ipcChannels.cancelWaveform, (event, raw: unknown) => {
    requests
      .get(event.sender)
      ?.get(requireString(raw, 'waveform request id'))
      ?.abort();
  });
  const projectRevisionRoot = (songId: string, revision: number): string => {
    if (
      !isSafePathComponent(songId) ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    ) {
      throw new TypeError('Invalid project identity');
    }
    return path.join(
      dataRoot(),
      'songs',
      songId,
      'revisions',
      String(revision),
    );
  };

  const projectArtifacts = async (
    songId: string,
    revision: number,
  ): Promise<{
    instrumental: string;
    vocals?: string;
    melody?: string;
    lyricsSync?: string;
  }> => {
    const revisionRoot = projectRevisionRoot(songId, revision);
    const manifestPath = path.join(revisionRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      artifacts?: unknown;
    };
    if (!Array.isArray(manifest.artifacts))
      throw new Error('Project manifest has no artifacts');
    const byName = new Map<string, string>();
    for (const item of manifest.artifacts) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (
        typeof record.logicalName !== 'string' ||
        typeof record.relativePath !== 'string'
      )
        continue;
      const resolved = path.resolve(revisionRoot, record.relativePath);
      const relative = path.relative(revisionRoot, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('Project artifact escapes revision root');
      byName.set(record.logicalName, resolved);
    }
    const instrumental = byName.get('instrumental');
    if (!instrumental) throw new Error('Instrumental artifact is missing');
    return {
      instrumental,
      vocals: byName.get('referenceVocal'),
      melody: byName.get('melody'),
      lyricsSync: byName.get('lyricsSync'),
    };
  };

  ipc.handle(ipcChannels.resolveProjectArtifacts, (_event, raw: unknown) => {
    const record = requireObject(raw, 'Project request');
    return projectArtifacts(
      requireString(record.songId, 'songId'),
      requireNumber(record.revision, 'revision'),
    );
  });

  // Peaks of the instrumental for the karaoke waveform; computed here because the renderer never decodes audio.
  ipc.handle(ipcChannels.waveformPeaks, async (event, raw: unknown) => {
    const record = requireObject(raw, 'Waveform request');
    const songId = requireString(record.songId, 'songId');
    const revision = requireNumber(record.revision, 'revision');
    const bins = requireNumber(record.bins, 'bins');
    if (
      !isSafePathComponent(songId) ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      throw new TypeError('Invalid project identity');
    return waveformRequest(event.sender, record, async (signal) => {
      try {
        if (revision > 0) {
          const { instrumental } = await projectArtifacts(songId, revision);
          signal?.throwIfAborted();
          return await waveformPeaks(instrumental, bins, signal);
        }
      } catch {
        // A cancelled local read must not start a new backend decode.
        signal?.throwIfAborted();
        // A missing or unreadable published waveform can still use the managed source below.
      }
      // Before the first revision, the backend decodes the managed imported source.
      const response = await backend.request(
        `/songs/${encodeURIComponent(songId)}/waveform?bins=${bins}`,
        { signal },
      );
      signal?.throwIfAborted();
      if (
        !response.ok ||
        !Array.isArray(response.body) ||
        !response.body.every(
          (value: unknown) =>
            typeof value === 'number' && Number.isFinite(value),
        )
      )
        throw new Error('Song waveform is unavailable');
      return response.body as number[];
    });
  });

  // Peaks of a saved take: the backend names the file, so the renderer never passes a path.
  ipc.handle(ipcChannels.recordingPeaks, async (event, raw: unknown) => {
    const record = requireObject(raw, 'Recording request');
    const bins = requireNumber(record.bins, 'bins');
    return waveformRequest(event.sender, record, async (signal) => {
      const response = await backend.request(
        `/recordings/${encodeURIComponent(requireString(record.recordingId, 'recordingId'))}`,
        { signal },
      );
      signal?.throwIfAborted();
      if (!response.ok)
        throw new Error(`Recording lookup failed: HTTP ${response.status}`);
      const { filePath, fileStatus } = response.body as {
        filePath?: unknown;
        fileStatus?: string;
      };
      if (['Preparing', 'PreparationFailed'].includes(fileStatus ?? ''))
        return [];
      try {
        return await waveformPeaks(
          requireString(filePath, 'filePath'),
          bins,
          signal,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    });
  });

  ipc.handle(ipcChannels.revealProject, async (_event, raw: unknown) => {
    const record = requireObject(raw, 'Project request');
    const songId = requireString(record.songId, 'songId');
    const revision = requireNumber(record.revision, 'revision');
    if (revision === 0) {
      if (!isSafePathComponent(songId))
        throw new TypeError('Invalid project identity');
      const error = await shell.openPath(
        path.join(dataRoot(), 'songs', songId),
      );
      if (error) throw new Error(error);
      return;
    }
    const root = projectRevisionRoot(songId, revision);
    shell.showItemInFolder(path.join(root, 'manifest.json'));
  });
  ipc.handle(ipcChannels.inspectWave, (_event, value: unknown) =>
    inspectWave(requireString(value, 'path')),
  );
};
