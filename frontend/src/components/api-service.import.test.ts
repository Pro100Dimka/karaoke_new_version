import { QueryClient, type InfiniteData } from '@tanstack/react-query';
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
