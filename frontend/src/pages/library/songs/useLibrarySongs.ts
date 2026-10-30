import { importSong as importCatalogSong } from "../../../api/api-service";
import { store } from "../../../providers/store";
import { pythonClient as catalog } from "../../../services/pythonClient";
import { libraryChanged, onLibraryChange } from "../../../services/backendEvents";
import type { ImportMetadata, ImportOptions, SongPatch } from "../../../contracts/clients";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { SongDto, SongSearch } from "../../../contracts/models";

import { useJobs } from "../../../providers/application";

export type LibrarySongsState =
  | { status: "loading" }
  | { status: "ready"; songs: readonly SongDto[] }
  | { status: "error" };

const emptyImports: readonly SongDto[] = [];

type SongPage = Awaited<ReturnType<typeof catalog.searchSongs>>;

export const useLibrarySongs = (filter?: SongSearch) => {
  const { pythonEpoch } = store.application.services;
  const { jobs } = useJobs();
  const client = useQueryClient();
  const queryKey = useMemo(() => ["songs", pythonEpoch, filter ?? null], [pythonEpoch, filter]);
  const { data: imports = emptyImports } = useQuery<readonly SongDto[]>({ queryKey: ["song-imports"], enabled: false });
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: async ({ signal, pageParam }): Promise<SongPage> => {
      const page = filter ? await catalog.searchSongs(filter, pageParam)
        : { items: await catalog.listSongs(), nextCursor: null };
      signal.throwIfAborted();
      return page;
    },
    getNextPageParam: (page) => page.nextCursor,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchInterval: filter ? false : 15_000,
    refetchIntervalInBackground: true,
  });
  const summary = useQuery({
    queryKey: ["song-summary", pythonEpoch],
    queryFn: () => catalog.songSummary(),
    enabled: !!filter,
    refetchInterval: 15_000,
  });
  const songs = useMemo(() => query.data?.pages.flatMap((page) => page.items), [query.data]);
  const refresh = useCallback(async () => {
    void client.cancelQueries({ queryKey });
    client.setQueryData<InfiniteData<SongPage>>(queryKey, (data) => data && ({ ...data,
      pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }));
    void client.invalidateQueries({ queryKey: ["song-summary", pythonEpoch] });
    await client.invalidateQueries({ queryKey });
  }, [client, queryKey, pythonEpoch]);
  useEffect(() => {
    client.removeQueries({ queryKey: ["songs"], type: "inactive" });
  }, [client, queryKey]);
  const reload = refresh;
  const replaceSong = async (saved: SongDto) => {
    await client.cancelQueries({ queryKey });
    client.setQueryData<InfiniteData<SongPage>>(queryKey, (data) => data && ({ ...data,
      pages: data.pages.map((page) => ({ ...page, items: page.items.map((song) => song.id === saved.id ? saved : song) })) }));
    if (filter) await refresh();
  };
  useEffect(() => onLibraryChange(() => void refresh()), [refresh]);
  const jobStates = jobs.map((job) => `${job.id}:${job.state}`).join("|");
  const previousJobs = useRef(jobStates);
  useEffect(() => {
    if (previousJobs.current === jobStates) return;
    previousJobs.current = jobStates;
    libraryChanged();
  }, [jobStates]);

  const importSong = (path: string, metadata?: ImportMetadata, options?: ImportOptions) =>
    importCatalogSong(client, path, metadata, options);

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
    await replaceSong(saved);
  };

  const removeSongCover = async (song: SongDto) => {
    const saved = await catalog.removeSongCover(song.id);
    await replaceSong(saved);
    return saved;
  };

  const deleteSong = async (song: SongDto) => {
    await catalog.deleteSong(song.id);
    await client.cancelQueries({ queryKey });
    client.setQueryData<InfiniteData<SongPage>>(queryKey, (data) => data && ({ ...data,
      pages: data.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.id !== song.id) })) }));
    await refresh();
  };

  const visibleState = useMemo<LibrarySongsState>(() => {
    if (!songs) return { status: query.isError ? "error" : "loading" };
    const state = { status: "ready" as const, songs: [...imports, ...songs] };
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
  }, [songs, query.isError, imports, jobs]);

  return {
    state: visibleState,
    summary: summary.data,
    summaryError: summary.isError,
    hasNextPage: query.hasNextPage && !query.isPlaceholderData && !query.isError,
    fetching: query.isFetching,
    stale: query.isPlaceholderData,
    pageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
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
