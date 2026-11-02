import { useId, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { pythonClient as backend } from '../../../../../../services/pythonClient';
import { historyKinds, type HistoryTab } from './historyModel';

const requests = {
  retry: false,
  gcTime: 0,
  networkMode: 'always',
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/** History pages and their title catalog have independent requests and retries. */
export const useHistory = () => {
  const view = useId();
  const [tab, setTab] = useState<HistoryTab>('performances');
  const history = useInfiniteQuery({
    ...requests,
    queryKey: ['history', view, tab],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const page = await backend.history(50, pageParam, historyKinds[tab]);
      signal.throwIfAborted();
      return page;
    },
    getNextPageParam: (last, pages) => {
      const offset = pages.reduce(
        (count, page) => count + page.items.length,
        0,
      );
      return offset < last.total ? offset : undefined;
    },
  });
  const titles = useQuery({
    ...requests,
    queryKey: ['history-titles', view],
    queryFn: async ({ signal }) => {
      const songs = await backend.listSongs();
      signal.throwIfAborted();
      return new Map(
        songs.map((song) => [song.id, `${song.artist} — ${song.title}`]),
      );
    },
  });
  const loadMore = () => void history.fetchNextPage();
  return {
    tab,
    setTab,
    events: history.data?.pages.flatMap((page) => page.items) ?? [],
    total: history.data?.pages.at(-1)?.total ?? 0,
    loading: history.isFetching,
    failed: history.isError && !history.isFetching,
    catalog: { titles: titles.data ?? null, failed: titles.isError },
    loadMore,
    retry: () => {
      if (history.isError)
        void (history.data ? history.fetchNextPage() : history.refetch());
      if (titles.isError) void titles.refetch();
    },
  };
};
