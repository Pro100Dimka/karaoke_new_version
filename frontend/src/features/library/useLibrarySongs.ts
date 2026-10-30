import { pythonClient as catalog } from "../../services/pythonClient";
import { libraryChanged, onLibraryChange } from "../../services/backendEvents";
import type { ImportMetadata, ImportOptions, SongPatch } from "../../contracts/clients";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SongDto } from "../../contracts/models";
import { useServices } from "../../app/ServicesContext";
import { useApp } from "../../app/AppContext";

export type LibrarySongsState =
  | { status: "loading" }
  | { status: "ready"; songs: readonly SongDto[] }
  | { status: "error" };

export const useLibrarySongs = () => {
  const { pythonEpoch } = useServices();
  const { jobs } = useApp("jobs");
  const [state, setState] = useState<LibrarySongsState>({ status: "loading" });
  const generation = useRef(0);

  const load = useCallback(async (silent: boolean) => {
    const requestGeneration = ++generation.current;
    if (!silent) setState({ status: "loading" });
    try {
      const songs = await catalog.listSongs();
      if (requestGeneration === generation.current)
        setState((current) => ({
          status: "ready",
          songs: [
            ...(current.status === "ready"
              ? current.songs.filter((song) => song.id.startsWith("import:"))
              : []),
            ...songs,
          ],
        }));
    } catch {
      // A failed background refresh keeps the last good snapshot visible.
      if (requestGeneration === generation.current)
        setState((current) =>
          silent && current.status === "ready" ? current : { status: "error" },
        );
    }
  }, [catalog]);

  const reload = useCallback(() => { libraryChanged(); return load(false); }, [load]);
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
    libraryChanged();
    void load(false);
    return () => {
      generation.current += 1;
    };
  }, [load, pythonEpoch]);

  useEffect(
    () => onLibraryChange(() => void load(true)),
    [load],
  );
  // The shared jobs view supplies progress without rereading every song. State transitions also
  // invalidate the catalog when the event stream is unavailable.
  const jobStates = jobs.map((job) => `${job.id}:${job.state}`).join("|");
  const previousJobs = useRef(jobStates);
  useEffect(() => {
    if (previousJobs.current === jobStates) return;
    previousJobs.current = jobStates;
    libraryChanged();
  }, [jobStates]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

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
        {
          ...options,
          onProgress: (value) => {
            options?.onProgress(value);
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
      setState((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              songs: [song, ...current.songs.filter((item) =>
                item.id !== placeholderId && item.id !== song.id,
              )],
            }
          : current,
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

  const processSong = async (song: SongDto, mode?: "lyrics") => {
    await catalog.processSong(song.id, mode);
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
    generation.current += 1;
    setState((current) => current.status === "ready"
      ? { status: "ready", songs: current.songs.filter((item) => item.id !== song.id) }
      : current);
    await refresh();
  };

  const visibleState = useMemo<LibrarySongsState>(() => {
    if (state.status !== "ready") return state;
    const activeJobs = new Map(jobs.filter((job) =>
      ["queued", "processing", "cancelling"].includes(job.state),
    ).map((job) => [job.songId, job]));
    if (activeJobs.size === 0) return state;
    return {
      ...state,
      songs: state.songs.map((song) => {
        const job = activeJobs.get(song.id);
        return job ? { ...song, jobId: job.id, stage: job.stage, progress: job.progress,
          status: job.state === "queued" ? "queued" : "processing" } : song;
      }),
    };
  }, [state, jobs]);

  return {
    state: visibleState,
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
