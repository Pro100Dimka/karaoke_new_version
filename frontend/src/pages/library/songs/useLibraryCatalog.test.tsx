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
import { useState, type ReactNode } from 'react';
import { pythonClient } from '../../../services/pythonClient';
import { libraryChanged } from '../../../services/backendEvents';
import { useLibraryCatalog } from './useLibraryCatalog';
import { store } from '../../../providers/store';
import LibrarySearchField from '../hero/filters&actions/search-field';
import type { LibraryFilters } from '../hero/filters&actions/search-field';
import { markPlayed } from './lastPlayed';
import { clearStorage } from '../../../shared/storage/localStore';
import { queueSongImport } from '../../../components/api-service';

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

it.each([
  { query: 'Adele', view: filters },
  { query: '', view: { ...filters, status: 'ready' as const } },
  { query: '', view: { ...filters, language: 'English' as const } },
  { query: '', view: { ...filters, duration: 'long' as const } },
])(
  'keeps an unrelated pending import out of the active filter ($query, $view)',
  async ({ query, view }) => {
    const matchingSong = {
      id: 'matching',
      title: 'Hello',
      artist: 'Adele',
      language: 'English' as const,
      status: 'ready' as const,
      durationSeconds: 360,
      createdAt: '2026-01-01',
      coverState: 'Fallback' as const,
      activeRevision: 1,
      projectFormatVersion: 1,
    };
    vi.mocked(pythonClient.searchSongs).mockResolvedValue({
      items: [matchingSong],
      nextCursor: null,
    });
    const { result } = renderHook(() => useLibraryCatalog(query, view, false), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await act(() => vi.advanceTimersByTimeAsync(1));
    act(() => {
      queueSongImport(client, 'C:\\Music\\Queen - Bohemian Rhapsody.mp3');
    });
    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(result.current.completeCatalog).toBe(false);
    expect(result.current.localSongs).toHaveLength(2);
    expect(result.current.visibleSongs.map((song) => song.id)).toEqual([
      'matching',
    ]);
  },
);

it('shows matching pending imports in the importing filter', async () => {
  vi.mocked(pythonClient.searchSongs).mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  const { result } = renderHook(
    () =>
      useLibraryCatalog('Queen', { ...filters, status: 'importing' }, false),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  act(() => {
    queueSongImport(client, 'C:\\Music\\Queen - Bohemian Rhapsody.mp3');
    queueSongImport(client, 'C:\\Music\\Adele - Hello.mp3');
  });
  await act(() => vi.advanceTimersByTimeAsync(1));

  expect(result.current.visibleSongs.map((song) => song.title)).toEqual([
    'Queen - Bohemian Rhapsody.mp3',
  ]);
});

it('applies search and status selected through the real library controls to pending cards', async () => {
  vi.mocked(pythonClient.searchSongs).mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  queueSongImport(client, 'C:\\Music\\Queen - Bohemian Rhapsody.mp3');
  queueSongImport(client, 'C:\\Music\\Adele - Hello.mp3');
  const LibraryView = () => {
    const [query, setQuery] = useState('');
    const [view, setView] = useState<LibraryFilters>({
      ...filters,
      sort: 'recent',
      direction: 'desc',
    });
    const { visibleSongs } = useLibraryCatalog(query, view, false);
    return (
      <>
        <LibrarySearchField
          query={query}
          filters={view}
          playlists={[]}
          locked={false}
          onQueryChange={setQuery}
          onFiltersApply={setView}
        />
        <ul>
          {visibleSongs.map((song) => (
            <li key={song.id}>{song.title}</li>
          ))}
        </ul>
      </>
    );
  };
  render(
    <QueryClientProvider client={client}>
      <LibraryView />
    </QueryClientProvider>,
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'Queen' },
  });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByRole('listitem')).toHaveTextContent('Queen');

  fireEvent.click(
    screen.getByRole('button', { name: tr('filtersAndSorting') }),
  );
  fireEvent.click(screen.getByLabelText(tr('library.search.status')));
  fireEvent.click(
    screen.getByRole('option', { name: tr('library.search.ready') }),
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);

  fireEvent.click(screen.getByLabelText(tr('library.search.status')));
  fireEvent.click(
    screen.getByRole('option', { name: tr('library.search.importing') }),
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByRole('listitem')).toHaveTextContent('Queen');
});

it.each([
  { title: 'Straße', query: 'STRASSE' },
  { title: 'ΟΣ', query: 'οσ' },
])(
  'preserves a backend search match for $title without repeating text matching',
  async ({ title, query }) => {
    const song = {
      id: 'server-match',
      title,
      artist: 'Singer',
      language: 'English' as const,
      status: 'ready' as const,
      durationSeconds: 180,
      createdAt: '2026-01-01',
      coverState: 'Fallback' as const,
      activeRevision: 1,
      projectFormatVersion: 1,
    };
    vi.mocked(pythonClient.searchSongs).mockResolvedValue({
      items: [song],
      nextCursor: 'next-server-page',
    });
    const { result } = renderHook(
      () => useLibraryCatalog(query, filters, false),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(result.current.visibleSongs).toEqual([song]);
    expect(result.current.completeCatalog).toBe(false);
    expect(result.current.catalog.hasNextPage).toBe(true);
    expect(result.current.catalog.data?.pages[0]?.nextCursor).toBe(
      'next-server-page',
    );
  },
);

it.each([
  { selecting: false, duration: 'long' as const, expected: ['five-minutes'] },
  { selecting: true, duration: 'long' as const, expected: ['five-minutes'] },
  { selecting: false, duration: 'medium' as const, expected: [] },
  { selecting: true, duration: 'medium' as const, expected: [] },
])(
  'keeps the five-minute boundary consistent for $duration (complete: $selecting)',
  async ({ selecting, duration, expected }) => {
    const song = {
      id: 'five-minutes',
      title: 'Five minutes',
      artist: 'Singer',
      language: 'English' as const,
      status: 'ready' as const,
      durationSeconds: 300,
      createdAt: '2026-01-01',
      coverState: 'Fallback' as const,
      activeRevision: 1,
      projectFormatVersion: 1,
    };
    vi.mocked(pythonClient.searchSongs).mockResolvedValue({
      items: duration === 'long' ? [song] : [],
      nextCursor: null,
    });
    vi.mocked(pythonClient.listSongs).mockResolvedValue([song]);
    const { result } = renderHook(
      () => useLibraryCatalog('', { ...filters, duration }, selecting),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(result.current.visibleSongs.map((item) => item.id)).toEqual(
      expected,
    );
  },
);

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

it('opens a large playlist without rescanning all membership IDs for each song', async () => {
  client.setQueryDefaults(['song-imports'], { queryFn: async () => [] });
  const songs = Array.from({ length: 500 }, (_, index) => ({
    id: `song-${index}`,
    title: `Song ${index}`,
    artist: 'Singer',
    language: 'English' as const,
    status: 'ready' as const,
    durationSeconds: 60,
    createdAt: '2026-01-01',
    coverState: 'Fallback' as const,
    activeRevision: 1,
    projectFormatVersion: 1,
  }));
  let membershipReads = 0;
  const songIds = new Proxy(
    songs.filter((_, i) => i % 2 === 0).map(({ id }) => id),
    {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) membershipReads++;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  store.preferences.karaokePlaylists = [
    { id: 'party', name: 'Party', songIds },
  ];
  vi.mocked(pythonClient.listSongs).mockResolvedValue(songs);
  const { result } = renderHook(
    () => useLibraryCatalog('', { ...filters, playlist: 'party' }, false),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(result.current.visibleSongs).toHaveLength(250);
  expect(
    result.current.visibleSongs.every(
      ({ id }) => Number(id.slice(5)) % 2 === 0,
    ),
  ).toBe(true);
  expect(membershipReads).toBeLessThanOrEqual(songIds.length * 4);
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
    await act(() => vi.advanceTimersByTimeAsync(201));
  }
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(2);
  act(() => libraryChanged());
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(pythonClient.searchSongs).toHaveBeenCalledTimes(3);
  rerender({ query: 'Adele' });
  await act(() => vi.advanceTimersByTimeAsync(201));
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
