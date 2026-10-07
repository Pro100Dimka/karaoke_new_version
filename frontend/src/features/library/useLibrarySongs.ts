import type { ImportMetadata, ImportOptions, SongPatch } from "../../contracts/clients";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SongDto } from "../../contracts/models";
import { useLibraryCatalog, useLibraryJobEvents } from "../../app/LibraryProvider";
import { useServices } from "../../app/ServicesContext";

export type LibrarySongsState =
  | { status: "loading" }
  | { status: "ready"; songs: readonly SongDto[] }
  | { status: "error" };

const activeStatuses = new Set<SongDto["status"]>(["queued", "processing"]);
const activeRefreshMilliseconds = 1200;

export const useLibrarySongs = () => {
  const catalog = useLibraryCatalog();
  const events = useLibraryJobEvents();
  const { pythonEpoch } = useServices();
  const [state, setState] = useState<LibrarySongsState>({ status: "loading" });
  const generation = useRef(0);

  const load = useCallback(async (silent: boolean) => {
    const requestGeneration = ++generation.current;
    if (!silent) setState({ status: "loading" });
    try {
      const songs = await catalog.listSongs();
      if (requestGeneration === generation.current)
        setState({ status: "ready", songs });
    } catch {
      // A failed background refresh keeps the last good snapshot visible.
      if (requestGeneration === generation.current && !silent)
        setState({ status: "error" });
    }
  }, [catalog]);

  const reload = useCallback(() => load(false), [load]);
  const refresh = useCallback(() => load(true), [load]);
  const replaceSong = (saved: SongDto) => {
    generation.current += 1;
    setState((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            songs: current.songs.map((song) =>
              song.id === saved.id ? saved : song,
            ),
          }
        : current,
    );
  };

  // A backend reconnect invalidates everything held from before the outage.
  useEffect(() => {
    void load(false);
    return () => {
      generation.current += 1;
    };
  }, [load, pythonEpoch]);

  // The backend pushes every job change; the list is re-read then, at most once per interval. Without
  // pushed events (plain browser) it is polled while songs are being processed, as before.
  const hasActiveJobs =
    state.status === "ready" &&
    state.songs.some((song) => activeStatuses.has(song.status));
  useEffect(
    () => events.subscribe(() => void load(true), activeRefreshMilliseconds),
    [load, events],
  );
  useEffect(() => {
    if (!hasActiveJobs || events.available()) return;
    const timer = window.setInterval(
      () => void load(true),
      activeRefreshMilliseconds,
    );
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, load, events]);

  const importSong = async (
    path: string,
    metadata?: ImportMetadata,
    options?: ImportOptions,
  ) => {
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
    setState((current) =>
      current.status === "ready"
        ? { status: "ready", songs: [placeholder, ...current.songs] }
        : current,
    );
    try {
      const song = await catalog.importSong(
        path,
        metadata,
        options && {
          ...options,
          onProgress: (value) => {
            options.onProgress(value);
            setState((current) =>
              current.status === "ready"
                ? {
                    status: "ready",
                    songs: current.songs.map((item) =>
                      item.id === placeholderId
                        ? {
                            ...item,
                            progress: value.progress,
                            stage: value.stage,
                            jobId: value.jobId,
                          }
                        : item,
                    ),
                  }
                : current,
            );
          },
        },
      );
      await refresh();
      return song;
    } catch (error) {
      setState((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              songs: current.songs.filter((item) => item.id !== placeholderId),
            }
          : current,
      );
      throw error;
    }
  };

  const processSong = async (song: SongDto) => {
    await catalog.processSong(song.id);
    await refresh();
  };

  const cancelJob = async (jobId: string) => {
    await catalog.cancelProcessing(jobId);
    await refresh();
  };

  const updateSong = async (song: SongDto, patch: SongPatch) => {
    const saved = await catalog.updateSong(song.id, patch);
    replaceSong(saved);
  };

  const removeSongCover = async (song: SongDto) => {
    const saved = await catalog.removeSongCover(song.id);
    replaceSong(saved);
    return saved;
  };

  const deleteSong = async (song: SongDto) => {
    await catalog.deleteSong(song.id);
    await refresh();
  };

  return {
    state,
    reload,
    refresh,
    importSong,
    processSong,
    cancelJob,
    updateSong,
    removeSongCover,
    deleteSong,
  };
};
