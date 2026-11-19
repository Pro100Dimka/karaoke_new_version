import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../contracts/models';
import { store } from '../../../providers/store';
import { pythonClient } from '../../../services/pythonClient';
import { useLibraryCatalog } from './useLibraryCatalog';

vi.mock('../../../services/pythonClient', () => ({
  pythonClient: {
    searchSongs: vi.fn(),
    listSongs: vi.fn(),
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
  vi.clearAllMocks();
  store.preferences.karaokePlaylists = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryDefaults(['song-imports'], { queryFn: async () => [] });
});
afterEach(() => client.clear());

it.each([
  { field: 'title', text: 'Straße', query: 'STRASSE', mode: 'selection' },
  { field: 'artist', text: 'Straße', query: 'STRASSE', mode: 'selection' },
  {
    field: 'filename',
    text: 'Straße.mp3',
    query: 'STRASSE',
    mode: 'selection',
  },
  { field: 'title', text: 'ΟΣ', query: 'οσ', mode: 'selection' },
  { field: 'title', text: 'Straße', query: 'STRASSE', mode: 'playlist' },
  { field: 'title', text: 'ΟΣ', query: 'οσ', mode: 'playlist' },
])(
  'keeps the server match in $field for $query when $mode switches to the full catalog',
  async ({ field, text, query, mode }) => {
    const song: SongDto = {
      id: 'matching',
      title: 'Song',
      artist: 'Singer',
      [field]: text,
      language: 'English',
      status: 'ready',
      durationSeconds: 180,
      createdAt: '2026-01-01',
      coverState: 'Fallback',
      activeRevision: 1,
      projectFormatVersion: 1,
    };
    vi.mocked(pythonClient.searchSongs).mockResolvedValue({
      items: [song],
      nextCursor: null,
    });
    vi.mocked(pythonClient.listSongs).mockResolvedValue([song]);
    store.preferences.karaokePlaylists = [
      { id: 'party', name: 'Party', songIds: [song.id] },
    ];
    const { result, rerender } = renderHook(
      ({ fullCatalog }) =>
        useLibraryCatalog(
          query,
          fullCatalog && mode === 'playlist'
            ? { ...filters, playlist: 'party' }
            : filters,
          fullCatalog && mode === 'selection',
        ),
      {
        initialProps: { fullCatalog: false },
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(result.current.visibleSongs).toEqual([song]));
    expect(result.current.completeCatalog).toBe(false);

    rerender({ fullCatalog: true });
    await waitFor(() => expect(pythonClient.listSongs).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.catalog.isFetching).toBe(false));

    expect(result.current.completeCatalog).toBe(true);
    expect(result.current.visibleSongs).toEqual([song]);
  },
);
