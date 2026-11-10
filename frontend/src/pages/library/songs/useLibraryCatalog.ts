import { useDeferredValue, useEffect, useMemo, useRef } from 'react';
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
import { loadLastPlayed } from './lastPlayed';
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
  const completeCatalog = !!room || selecting || filters.sort === 'played';
  const serverFilter = useMemo(
    () => ({ ...filters, query: deferredQuery }),
    [filters, deferredQuery],
  );
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
  const played = useMemo(() => loadLastPlayed(), []);
  const visibleSongs = useMemo(
    () =>
      completeCatalog
        ? selectLibrarySongs(songs, serverFilter, played)
        : serverFilter.sort === 'recent'
          ? [...songs].sort((a, b) =>
              compareAddedSongs(a, b, serverFilter.direction),
            )
          : songs,
    [songs, completeCatalog, serverFilter, played],
  );

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
