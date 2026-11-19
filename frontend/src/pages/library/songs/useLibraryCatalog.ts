import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { mergeRoomLibrary } from '../../../application/room/roomLibrary';
import {
  refreshSongs,
  songsQuery,
  songSummaryQuery,
} from '../../../components/api-service';
import type { SongDto } from '../../../contracts/models';
import { useJobs } from '../../../providers/application';
import { store } from '../../../providers/store';
import {
  libraryChanged,
  onLibraryChange,
} from '../../../services/backendEvents';
import type {
  LibraryFilters,
  LibraryViewFilters,
} from '../hero/filters&actions/search-field';
import { loadLastPlayed, onLastPlayedChange } from './lastPlayed';
import { compareAddedSongs, selectLibrarySongs } from './librarySelectors';

const emptyImports: readonly SongDto[] = [];

/** Owns data loading, live job status, room merging and library filtering. */
export const useLibraryCatalog = (
  query: string,
  viewFilters: LibraryViewFilters,
  selecting: boolean,
) => {
  const { room } = store.online;
  const { preferences } = store;
  const deferredQuery = useDeferredValue(query);
  const filters: LibraryFilters = useMemo(
    () => ({
      ...viewFilters,
      sort: preferences.librarySort,
      direction: preferences.librarySortDirection,
    }),
    [viewFilters, preferences.librarySort, preferences.librarySortDirection],
  );
  const playlist = preferences.karaokePlaylists.find(
    (item) => item.id === filters.playlist,
  );
  const completeCatalog =
    !!room || selecting || filters.sort === 'played' || !!playlist;
  const serverFilter = useMemo(() => {
    // Playlist membership is local; keep the existing server search contract.
    const { playlist: _playlist, ...search } = filters;
    return { ...search, artwork: 'all' as const, query: deferredQuery };
  }, [filters, deferredQuery]);
  const client = useQueryClient();
  const { pythonEpoch } = store.application.services;
  const { jobs } = useJobs();
  const queryOptions = songsQuery(
    pythonEpoch,
    completeCatalog ? undefined : serverFilter,
  );
  const catalog = useInfiniteQuery({
    ...queryOptions,
    placeholderData: keepPreviousData,
  });
  const summary = useQuery({
    ...songSummaryQuery(pythonEpoch),
    enabled: false,
  });
  const { data: imports = emptyImports } = useQuery<readonly SongDto[]>({
    queryKey: ['song-imports'],
    enabled: false,
  });
  useEffect(() => {
    client.removeQueries({ queryKey: ['songs'], type: 'inactive' });
  }, [client, pythonEpoch, completeCatalog]);
  useEffect(
    () =>
      onLibraryChange(() => {
        void refreshSongs(client);
      }),
    [client],
  );
  const jobStates = jobs.map((job) => `${job.id}:${job.state}`).join('|');
  const previousJobs = useRef(jobStates);
  useEffect(() => {
    if (previousJobs.current === jobStates) return;
    previousJobs.current = jobStates;
    libraryChanged();
  }, [jobStates]);
  const localSongs = useMemo(() => {
    const songs = catalog.data?.pages.flatMap((page) => page.items) ?? [];
    const pending =
      filters.sort === 'recent' && filters.direction === 'asc'
        ? [...imports].reverse()
        : imports;
    const active = new Map(
      jobs
        .filter((job) =>
          ['queued', 'processing', 'cancelling'].includes(job.state),
        )
        .map((job) => [job.songId, job]),
    );
    return [...pending, ...songs].map((song) => {
      const job = active.get(song.id);
      return job
        ? {
            ...song,
            jobId: job.id,
            stage: job.stage,
            progress: job.progress,
            status:
              job.state === 'queued'
                ? ('queued' as const)
                : ('processing' as const),
          }
        : song;
    });
  }, [catalog.data, imports, jobs, filters.sort, filters.direction]);
  const selfId = room?.participants.find((person) => person.self)?.id ?? '';
  const songs = useMemo(
    () => mergeRoomLibrary(localSongs, room?.sharedSongs ?? [], selfId),
    [localSongs, room?.sharedSongs, selfId],
  );
  const [played, setPlayed] = useState(loadLastPlayed);
  useEffect(() => {
    const stop = onLastPlayedChange(setPlayed);
    setPlayed(loadLastPlayed());
    return stop;
  }, []);
  const visibleSongs = useMemo(() => {
    if (completeCatalog)
      return selectLibrarySongs(
        playlist
          ? songs.filter((song) => playlist.songIds.includes(song.id))
          : songs,
        serverFilter,
        played,
      );
    // Only pending imports need local filtering. Server pages own text matching
    // and cursor order, including the previous results kept during a new search.
    const hiddenImports = new Set(imports.map((song) => song.id));
    for (const song of selectLibrarySongs(imports, serverFilter))
      hiddenImports.delete(song.id);
    const matching = hiddenImports.size
      ? songs.filter((song) => !hiddenImports.has(song.id))
      : songs;
    return serverFilter.sort === 'recent'
      ? [...matching].sort((a, b) =>
          compareAddedSongs(a, b, serverFilter.direction),
        )
      : matching;
  }, [songs, completeCatalog, imports, serverFilter, played, playlist]);

  return {
    catalog,
    summary,
    client,
    localSongs,
    songs,
    visibleSongs,
    completeCatalog,
  };
};
