import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pythonClient } from '../../../services/pythonClient';
import { useLibraryCatalog } from './useLibraryCatalog';

vi.mock('../../../services/pythonClient', () => ({
  pythonClient: { searchSongs: vi.fn(), listSongs: vi.fn() },
}));
vi.mock('../../../providers/store', () => ({
  store: {
    online: { room: null },
    preferences: {
      librarySort: 'recent',
      librarySortDirection: 'desc',
      karaokePlaylists: [],
    },
    application: { services: { pythonEpoch: 0 } },
  },
}));
vi.mock('../../../providers/application', () => ({
  useJobs: () => ({ jobs: [] }),
}));

const filters = {
  status: 'all',
  language: 'all',
  duration: 'all',
  artwork: 'all',
} as const;
const songs = ['Queen', 'Adele'].map((title) => ({
  id: title,
  title,
  artist: 'Singer',
  language: 'English' as const,
  status: 'ready' as const,
  durationSeconds: 180,
  createdAt: '2026-01-01',
  coverState: 'Fallback' as const,
  activeRevision: 1,
  projectFormatVersion: 1,
}));
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const advance = (milliseconds: number) =>
  act(() => vi.advanceTimersByTimeAsync(milliseconds));
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryDefaults(['song-imports'], { queryFn: async () => [] });
  vi.mocked(pythonClient.searchSongs).mockResolvedValue({
    items: songs,
    nextCursor: null,
  });
  vi.mocked(pythonClient.listSongs).mockResolvedValue(songs);
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});

it('keeps the previous page visible and sends one search after a typing burst', async () => {
  const { result, rerender } = renderHook(
    ({ query }) => useLibraryCatalog(query, filters, false),
    { wrapper, initialProps: { query: '' } },
  );
  await advance(1);
  const previous = result.current.visibleSongs;
  for (const query of ['Q', 'Qu', 'Que', 'Quee', 'Queen']) {
    rerender({ query });
    await advance(40);
    expect(result.current.visibleSongs).toEqual(previous);
  }
  expect(pythonClient.searchSongs).toHaveBeenCalledOnce();
  await advance(200);
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(2);
  expect(pythonClient.searchSongs).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: 'Queen' }),
    null,
  );
});

it('clears the remote search immediately and cancels an unfinished term', async () => {
  const { rerender } = renderHook(
    ({ query }) => useLibraryCatalog(query, filters, false),
    { wrapper, initialProps: { query: 'Queen' } },
  );
  await advance(1);
  rerender({ query: 'Queen song' });
  await advance(40);
  rerender({ query: '' });
  await advance(1);
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(2);
  expect(pythonClient.searchSongs).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: '' }),
    null,
  );
  await advance(500);
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(2);
});

it('filters the complete local catalog without waiting for remote search', async () => {
  const { result, rerender } = renderHook(
    ({ query }) => useLibraryCatalog(query, filters, true),
    { wrapper, initialProps: { query: '' } },
  );
  await advance(1);
  rerender({ query: 'Queen' });
  expect(result.current.visibleSongs.map(({ title }) => title)).toEqual([
    'Queen',
  ]);
  expect(pythonClient.searchSongs).not.toHaveBeenCalled();
  expect(pythonClient.listSongs).toHaveBeenCalledOnce();
});

it('does not send a pending search after leaving the library', async () => {
  const { rerender, unmount } = renderHook(
    ({ query }) => useLibraryCatalog(query, filters, false),
    { wrapper, initialProps: { query: '' } },
  );
  await advance(1);
  rerender({ query: 'Queen' });
  await advance(40);
  unmount();
  await advance(500);
  expect(pythonClient.searchSongs).toHaveBeenCalledOnce();
});
