import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../contracts/models';
import { store } from '../../../providers/store';
import '../../../providers/localization';
import LibrarySearchField, {
  type LibraryFilters,
} from '../hero/filters&actions/search-field';
import { clearStorage } from '../../../shared/storage/localStore';
import LibrarySongs from './index';
import tiedApi from './catalog-order.api-fixture.json';
import unicodeApi from './catalog-order-unicode.api-fixture.json';
import shortApi from './catalog-short.api-fixture.json';

const fixtures = { ties: tiedApi, unicode: unicodeApi };

vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock('../../../providers/application', () => ({
  useJobs: () => ({ jobs: [] }),
  useRoomLibraryCommands: () => null,
}));
vi.mock('../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../modals/recordings', () => ({ RecordingsModal: () => null }));
vi.mock('../modals/settings', () => ({ openSettings: vi.fn() }));
vi.mock('../modals/song-settings', () => ({ SongSettingsModal: () => null }));
// These small catalogs fit together; bypass only geometry, which jsdom does not provide.
vi.mock('./song-grid', () => ({
  VirtualGrid: ({
    items,
    renderItem,
  }: {
    items: SongDto[];
    renderItem(song: SongDto): ReactNode;
  }) => (
    <div>
      {items.map((song) => (
        <div key={song.id}>{renderItem(song)}</div>
      ))}
    </div>
  ),
}));

let client: QueryClient;
let requested: PythonBridgeRequest[];

beforeEach(() => {
  store.setLanguage('ru');
  store.returnFromKaraoke(null);
  requested = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

const installResponses = (
  api: (typeof fixtures)[keyof typeof fixtures],
  shortIds?: readonly string[],
) => {
  store.updatePreferences({
    karaokePlaylists: [
      {
        id: 'all-songs',
        name: 'My selection',
        songIds: api.songs.map((song) => song.songId),
      },
    ],
  });
  // Responses below preserve the DTO fields and ordering recorded from real
  // /songs and /songs/search calls after importing WAVs and a live Opus file
  // whose duration is unknown. Cyrillic/casefold ties and accents stay intact.
  // All filters, paging/DTO mapping and card-selection behavior remain real.
  Object.assign(window, {
    desktop: {
      pythonRequest: async (request: PythonBridgeRequest) => {
        requested.push(request);
        const url = new URL(request.path, 'http://backend');
        if (request.method !== 'GET')
          throw new Error(`Unexpected ${request.method}`);
        let ids: readonly string[] = api.songs.map((song) => song.songId);
        if (url.pathname === '/songs/search') {
          const key =
            `${url.searchParams.get('sort')}-${url.searchParams.get('descending') === 'true' ? 'desc' : 'asc'}` as keyof typeof api.orders;
          ids = api.orders[key];
          if (url.searchParams.get('duration') === 'short') {
            if (!shortIds)
              throw new Error('Missing short-duration API fixture');
            ids = shortIds;
          }
        } else if (url.pathname !== '/songs') {
          throw new Error(`Unexpected ${request.path}`);
        }
        return {
          ok: true,
          status: 200,
          body: {
            items: ids.map((id) =>
              api.songs.find((song) => song.songId === id)!,
            ),
            nextCursor: null,
          },
        };
      },
      onBackendEvent: () => () => undefined,
    },
  });
};

afterEach(() => {
  client.clear();
  clearStorage();
  Reflect.deleteProperty(window, 'desktop');
});

const Catalog = ({
  duration = 'all',
}: {
  duration?: LibraryFilters['duration'];
}) => {
  const [filters, setFilters] = useState<LibraryFilters>({
    status: 'all',
    language: 'all',
    duration,
    artwork: 'all',
    playlist: 'all',
    sort: store.preferences.librarySort,
    direction: store.preferences.librarySortDirection,
  });
  return (
    <QueryClientProvider client={client}>
      <LibrarySearchField
        query=""
        filters={filters}
        playlists={store.preferences.karaokePlaylists}
        locked={false}
        onQueryChange={() => undefined}
        onFiltersApply={setFilters}
      />
      <LibrarySongs
        playlistsOpen={false}
        onClosePlaylists={() => undefined}
        onReady={() => undefined}
        view={{ query: '', filters }}
        onOpenProcessing={() => undefined}
        pageRef={{ current: null }}
        onPlay={() => undefined}
        songSelection={() => undefined}
      />
    </QueryClientProvider>
  );
};

it.each(
  (['ties', 'unicode'] as const).flatMap((dataset) =>
    (['title', 'artist', 'duration', 'bpm'] as const).flatMap((sort) =>
      (['asc', 'desc'] as const).flatMap((direction) =>
        (['selection', 'playlist'] as const).map((mode) => ({
          dataset,
          sort,
          direction,
          mode,
        })),
      ),
    ),
  ),
)(
  'keeps $sort/$direction card order with $dataset when $mode loads the full catalog',
  async ({ dataset, sort, direction, mode }) => {
    const api = fixtures[dataset];
    installResponses(api);
    store.updatePreferences({
      librarySort: sort,
      librarySortDirection: direction,
    });
    const expected = api.orders[`${sort}-${direction}`].map((id) => {
      const song = api.songs.find((song) => song.songId === id)!;
      return `${song.artist} - ${song.title}`;
    });
    const cardOrder = () =>
      screen
        .getAllByRole('listitem')
        .map((card) => card.getAttribute('aria-label'));
    render(<Catalog />);
    await screen.findByRole('checkbox', {
      name: tr('selectSongName', { name: api.songs[0]!.title }),
    });
    expect(cardOrder()).toEqual(expected);

    if (mode === 'selection') {
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: tr('selectSongName', { name: api.songs[0]!.title }),
        }),
      );
    } else {
      fireEvent.click(
        screen.getByRole('button', { name: tr('filtersAndSorting') }),
      );
      fireEvent.click(screen.getByLabelText(tr('library.search.playlist')));
      fireEvent.click(screen.getByRole('option', { name: 'My selection' }));
    }
    await waitFor(() =>
      expect(requested.some(({ path }) => path === '/songs?limit=200')).toBe(
        true,
      ),
    );
    await waitFor(() => expect(client.isFetching()).toBe(0));

    expect(cardOrder()).toEqual(expected);
  },
);

it.each(['selection', 'playlist'] as const)(
  'keeps an unknown-duration song outside the short filter after %s, and restores it for all durations',
  async (mode) => {
    installResponses(unicodeApi, shortApi.ids);
    store.updatePreferences({
      librarySort: 'title',
      librarySortDirection: 'asc',
    });
    const unknown = unicodeApi.songs.find((song) => song.duration === null)!;
    const known = unicodeApi.songs.find(
      (song) => song.songId === shortApi.ids[0],
    )!;
    const unknownLabel = tr('selectSongName', { name: unknown.title });
    render(<Catalog duration="short" />);
    const selectKnown = await screen.findByRole('checkbox', {
      name: tr('selectSongName', { name: known.title }),
    });
    expect(
      screen.queryByRole('checkbox', { name: unknownLabel }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(shortApi.ids.length);

    if (mode === 'selection') {
      fireEvent.click(selectKnown);
    } else {
      fireEvent.click(
        screen.getByRole('button', { name: tr('filtersAndSorting') }),
      );
      fireEvent.click(screen.getByLabelText(tr('library.search.playlist')));
      fireEvent.click(screen.getByRole('option', { name: 'My selection' }));
    }
    await waitFor(() =>
      expect(requested.some(({ path }) => path === '/songs?limit=200')).toBe(
        true,
      ),
    );
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(
      screen.queryByRole('checkbox', { name: unknownLabel }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(shortApi.ids.length);

    const filters = screen.getByRole('button', {
      name: tr('filtersAndSorting'),
    });
    if (filters.getAttribute('aria-expanded') !== 'true')
      fireEvent.click(filters);
    fireEvent.click(screen.getByLabelText(tr('library.search.duration')));
    fireEvent.click(
      screen.getByRole('option', { name: tr('library.search.all') }),
    );
    expect(
      await screen.findByRole('checkbox', { name: unknownLabel }),
    ).toBeVisible();
  },
);
