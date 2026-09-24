import type { ImportMetadata, ImportOptions } from "../../contracts/clients";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SongDto } from "../../contracts/models";
import type { SongPatch } from "../../contracts/clients";
import { pythonClient } from "../../services/pythonClient";
import { useServices } from "../../app/ServicesContext";

export type LibrarySongsState =
  | { status: "loading" }
  | { status: "ready"; songs: readonly SongDto[] }
  | { status: "error" };

const activeStatuses = new Set<SongDto["status"]>(["queued", "processing"]);
const activePollMilliseconds = 1200;

export const useLibrarySongs = () => {
  const { pythonEpoch } = useServices();
  const [state, setState] = useState<LibrarySongsState>({ status: "loading" });
  const generation = useRef(0);

  const load = useCallback(async (silent: boolean) => {
    const requestGeneration = ++generation.current;
    if (!silent) setState({ status: "loading" });
    try {
      const songs = await pythonClient.listSongs();
      if (requestGeneration === generation.current) setState({ status: "ready", songs });
    } catch {
      // A failed background refresh keeps the last good snapshot visible.
      if (requestGeneration === generation.current && !silent) setState({ status: "error" });
    }
  }, []);

  const reload = useCallback(() => load(false), [load]);
  const refresh = useCallback(() => load(true), [load]);

  // A backend reconnect invalidates everything held from before the outage.
  useEffect(() => {
    void load(false);
    return () => {
      generation.current += 1;
    };
  }, [load, pythonEpoch]);

  const hasActiveJobs = state.status === "ready" && state.songs.some(song => activeStatuses.has(song.status));
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = window.setInterval(() => void load(true), activePollMilliseconds);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, load]);

  const importSong = async (path: string, metadata?: ImportMetadata, options?: ImportOptions) => {
    const placeholderId = `import:${crypto.randomUUID()}`;
    const placeholder: SongDto = {
      id: placeholderId,
      title: path.split(/[\\/]/).pop() ?? path,
      artist: "",
      language: "Auto",
      status: "importing",
      progress: 0,
      stage: "Queued",
      durationSeconds: 0,
      createdAt: new Date().toISOString(),
      coverState: "Fallback",
      activeRevision: 0,
      projectFormatVersion: 1,
    };
    setState(current => current.status === "ready"
      ? { status: "ready", songs: [placeholder, ...current.songs] }
      : current);
    try {
      const song = await pythonClient.importSong(path, metadata, options && {
        ...options,
        onProgress: value => {
          options.onProgress(value);
          setState(current => current.status === "ready"
            ? { status: "ready", songs: current.songs.map(item => item.id === placeholderId
              ? { ...item, progress: value.progress, stage: value.stage, jobId: value.jobId }
              : item) }
            : current);
        },
      });
      await refresh();
      return song;
    } catch (error) {
      setState(current => current.status === "ready"
        ? { status: "ready", songs: current.songs.filter(item => item.id !== placeholderId) }
        : current);
      throw error;
    }
  };

  const processSong = async (song: SongDto) => {
    await pythonClient.processSong(song.id);
    await refresh();
  };

  const cancelJob = async (jobId: string) => {
    await pythonClient.cancelProcessing(jobId);
    await refresh();
  };

  const updateSong = async (song: SongDto, patch: SongPatch) => {
    const saved = await pythonClient.updateSong(song.id, patch);
    generation.current += 1;
    setState(current => current.status === "ready"
      ? { status: "ready", songs: current.songs.map(item => item.id === saved.id ? saved : item) }
      : current);
  };

  const removeSongCover = async (song: SongDto) => {
    const saved = await pythonClient.removeSongCover(song.id);
    setState(current => current.status === "ready"
      ? { status: "ready", songs: current.songs.map(item => item.id === saved.id ? saved : item) }
      : current);
    return saved;
  };

  const deleteSong = async (song: SongDto) => {
    await pythonClient.deleteSong(song.id);
    await refresh();
  };

  return { state, reload, refresh, importSong, processSong, cancelJob, updateSong, removeSongCover, deleteSong };
};
