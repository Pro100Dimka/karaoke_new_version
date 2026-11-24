import {
  QueryClient,
  QueryObserver,
  type InfiniteData,
} from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { SongDto, SongSearch } from '../contracts/models';
import { pythonClient } from '../services/pythonClient';
import { importSong, songsQuery, type SongPage } from './api-service';

vi.mock('../services/pythonClient', () => ({
  pythonClient: { importSong: vi.fn() },
}));

const client = new QueryClient();
afterEach(() => client.clear());

it('adds a completed import only to the complete catalog before filtered searches refresh', async () => {
  const existing: SongDto = {
    id: 'adele',
    title: 'Hello',
    artist: 'Adele',
    status: 'ready',
    language: 'English',
    durationSeconds: 300,
    createdAt: '2026-01-01',
    coverState: 'Fallback',
    activeRevision: 1,
    projectFormatVersion: 1,
  };
  const imported: SongDto = {
    ...existing,
    id: 'queen',
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    status: 'not-processed',
  };
  vi.mocked(pythonClient.importSong).mockResolvedValue(imported);
  const filter: SongSearch = {
    query: 'Adele',
    status: 'ready',
    language: 'all',
    duration: 'all',
    artwork: 'all',
    sort: 'recent',
    direction: 'desc',
  };
  const fullKey = songsQuery(0).queryKey;
  const filteredKey = songsQuery(0, filter).queryKey;
  const page: InfiniteData<SongPage> = {
    pages: [{ items: [existing], nextCursor: 'next-page' }],
    pageParams: [null],
  };
  client.setQueryData(fullKey, {
    ...page,
    pages: [{ items: [existing], nextCursor: null }],
  });
  client.setQueryData(filteredKey, page);

  await importSong(client, 'C:\\Music\\Queen - Bohemian Rhapsody.mp3');

  expect(
    client.getQueryData<InfiniteData<SongPage>>(fullKey)?.pages[0]?.items,
  ).toEqual([imported, existing]);
  expect(client.getQueryData(filteredKey)).toEqual(page);
  expect(client.getQueryState(filteredKey)?.isInvalidated).toBe(true);
  expect(client.getQueryData(['song-imports'])).toEqual([]);
});

it.each([false, true])(
  'lets an in-flight catalog finish after import, then reads the new song (complete: %s)',
  async (complete) => {
    vi.useFakeTimers();
    const filter: SongSearch = {
      query: '',
      status: 'all',
      language: 'all',
      duration: 'all',
      artwork: 'all',
      sort: 'recent',
      direction: 'desc',
    };
    const imported: SongDto = {
      id: 'new',
      title: 'New song',
      artist: 'Singer',
      status: 'not-processed',
      language: 'English',
      durationSeconds: 180,
      createdAt: '2026-01-01',
      coverState: 'Fallback',
      activeRevision: 0,
      projectFormatVersion: 1,
    };
    vi.mocked(pythonClient.importSong).mockResolvedValue(imported);
    const key = songsQuery(0, complete ? undefined : filter).queryKey;
    const empty: InfiniteData<SongPage> = {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    };
    const reads: {
      signal: AbortSignal;
      resolve(data: InfiniteData<SongPage>): void;
    }[] = [];
    client.setQueryData(key, empty);
    const observer = new QueryObserver(client, {
      queryKey: key,
      staleTime: Infinity,
      queryFn: ({ signal }) =>
        new Promise<InfiniteData<SongPage>>((resolve) => {
          reads.push({ signal, resolve });
        }),
    });
    const stop = observer.subscribe(() => undefined);
    try {
      const background = observer.refetch();
      await vi.advanceTimersByTimeAsync(0);
      const importing = importSong(client, 'D:\\Music\\new.mp3');
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toHaveLength(1);
      expect(reads[0]?.signal.aborted).toBe(false);
      if (complete)
        expect(
          client.getQueryData<readonly SongDto[]>(['song-imports']),
        ).toEqual([expect.objectContaining({ status: 'importing' })]);
      reads[0]!.resolve(empty);
      await background;
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toHaveLength(2);
      reads[1]!.resolve({
        ...empty,
        pages: [{ items: [imported], nextCursor: null }],
      });
      await importing;
      expect(
        client.getQueryData<InfiniteData<SongPage>>(key)?.pages[0]?.items,
      ).toEqual([imported]);
    } finally {
      stop();
      client.clear();
      vi.useRealTimers();
    }
  },
);
