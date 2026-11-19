import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { pythonClient } from '../../../services/pythonClient';
import { libraryChanged } from '../../../services/backendEvents';
import { useLibraryCatalog } from './useLibraryCatalog';
import { store } from '../../../providers/store';
import LibrarySearchField from '../hero/filters&actions/search-field';
import { markPlayed } from './lastPlayed';
import { clearStorage } from '../../../shared/storage/localStore';

vi.mock('../../../services/pythonClient', () => ({
  pythonClient: {
    searchSongs: vi.fn(async () => ({ items: [], nextCursor: null })),
    listSongs: vi.fn(async () => []),
  },
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
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearStorage();
  store.preferences.librarySort = 'recent';
  store.preferences.librarySortDirection = 'desc';
  store.preferences.karaokePlaylists = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});

it('updates last-played sorting while the library stays open on the laptop', async () => {
  store.preferences.librarySort = 'played';
  const song = {
    title: 'Song',
    artist: 'Singer',
    language: 'English' as const,
    status: 'ready' as const,
    durationSeconds: 60,
    createdAt: '2026-01-01',
    coverState: 'Fallback' as const,
    activeRevision: 1,
    projectFormatVersion: 1,
  };
  vi.mocked(pythonClient.listSongs).mockResolvedValue([
    { ...song, id: 'first' },
    { ...song, id: 'second' },
  ]);
  markPlayed('first', 100);
  markPlayed('second', 200);
  const { result } = renderHook(() => useLibraryCatalog('', filters, false), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(result.current.visibleSongs.map((song) => song.id)).toEqual([
    'second',
    'first',
  ]);
  act(() => markPlayed('first', 300));
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(result.current.visibleSongs.map((song) => song.id)).toEqual([
    'first',
    'second',
  ]);
});

it('reuses recent searches, invalidates changes and expires unused results', async () => {
  const { rerender, unmount } = renderHook(
    ({ query }) => useLibraryCatalog(query, filters, false),
    {
      initialProps: { query: '' },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  for (const query of ['Adele', '', 'Adele', '']) {
    rerender({ query });
    await act(() => vi.advanceTimersByTimeAsync(1));
  }
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(2);
  act(() => libraryChanged());
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(3);
  rerender({ query: 'Adele' });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(4);
  await act(() => vi.advanceTimersByTimeAsync(30_001));
  expect(
    client.getQueryCache().findAll({ queryKey: ['songs'], type: 'inactive' }),
  ).toHaveLength(0);
  rerender({ query: '' });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(5);
  unmount();
  store.preferences.karaokePlaylists = [
    { id: 'p', name: 'Favourites', songIds: ['kept'] },
  ];
  const song = {
    id: 'kept',
    title: 'Keep',
    artist: 'Singer',
    language: 'English' as const,
    status: 'ready' as const,
    durationSeconds: 60,
    createdAt: '2026-01-01',
    coverState: 'Fallback' as const,
    activeRevision: 1,
    projectFormatVersion: 1,
  };
  vi.mocked(pythonClient.searchSongs).mockResolvedValue({
    items: [song, { ...song, id: 'other', title: 'Other' }],
    nextCursor: null,
  });
  vi.mocked(pythonClient.listSongs).mockResolvedValue([
    song,
    { ...song, id: 'other', title: 'Other' },
  ]);
  client.clear();
  const playlist = renderHook(
    () => useLibraryCatalog('', { ...filters, playlist: 'p' }, false),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(playlist.result.current.visibleSongs.map((song) => song.id)).toEqual([
    'kept',
  ]);
  expect(playlist.result.current.completeCatalog).toBe(true);
  playlist.unmount();
  const search = render(
    <LibrarySearchField
      query=""
      filters={{
        ...filters,
        playlist: 'deleted',
        sort: 'recent',
        direction: 'desc',
      }}
      playlists={[]}
      locked={false}
      onQueryChange={vi.fn()}
      onFiltersApply={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: tr('filtersAndSorting') }),
  );
  expect(
    screen.getByLabelText(tr('library.search.playlist')),
  ).toHaveTextContent(tr('library.search.all'));
  search.unmount();
});
