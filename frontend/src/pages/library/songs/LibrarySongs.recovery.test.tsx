import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../contracts/models';
import { libraryChanged } from '../../../services/backendEvents';
import { pythonClient } from '../../../services/pythonClient';
import LibrarySongs from './index';

vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock('../../../providers/store', () => ({
  store: {
    playback: { returned: null },
    application: { localProcessing: false, services: { pythonEpoch: 0 } },
    online: { room: null },
    preferences: {
      librarySort: 'recent',
      librarySortDirection: 'desc',
      karaokePlaylists: [],
    },
  },
}));
vi.mock('../../../providers/application', () => ({
  useJobs: () => ({ jobs: [] }),
  useRoomLibraryCommands: () => null,
}));
vi.mock('../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../../services/pythonClient', () => ({
  pythonClient: { searchSongs: vi.fn(), listSongs: vi.fn() },
}));
vi.mock('../modals/recordings', () => ({ RecordingsModal: () => null }));
vi.mock('../modals/settings', () => ({ openSettings: vi.fn() }));
vi.mock('../modals/song-settings', () => ({ SongSettingsModal: () => null }));
vi.mock('./song-grid', () => ({
  VirtualGrid: ({
    items,
    hasNextPage,
    loading,
    loadMore,
  }: {
    items: SongDto[];
    hasNextPage: boolean;
    loading: boolean;
    loadMore(): void;
  }) => (
    <section>
      <ul>
        {items.map((song) => (
          <li key={song.id}>{song.title}</li>
        ))}
      </ul>
      {hasNextPage && (
        <button disabled={loading} onClick={loadMore}>
          Load next page
        </button>
      )}
    </section>
  ),
}));

const song = (id: string): SongDto => ({
  id,
  title: id,
  artist: 'Singer',
  status: 'ready',
  language: 'English',
  durationSeconds: 180,
  createdAt: '2026-11-19T00:00:00Z',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
});
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => client.clear());

const showLibrary = () =>
  render(
    <QueryClientProvider client={client}>
      <LibrarySongs
        playlistsOpen={false}
        onClosePlaylists={vi.fn()}
        onReady={vi.fn()}
        view={{
          query: '',
          filters: {
            status: 'all',
            language: 'all',
            duration: 'all',
            artwork: 'all',
          },
        }}
        onOpenProcessing={vi.fn()}
        pageRef={{ current: null }}
        onPlay={vi.fn()}
        songSelection={() => undefined}
      />
    </QueryClientProvider>,
  );

it.each(['refresh', 'next page'] as const)(
  'keeps cached songs and offers retry after a failed %s, then resumes pagination',
  async (request) => {
    const firstPage = { items: [song('First song')], nextCursor: 'page-2' };
    vi.mocked(pythonClient.searchSongs)
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error('Catalog request timed out'))
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce({
        items: [song('Second song')],
        nextCursor: null,
      });
    showLibrary();
    expect(await screen.findByText('First song')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Load next page' }),
    ).toBeEnabled();

    if (request === 'refresh') act(() => libraryChanged());
    else
      fireEvent.click(screen.getByRole('button', { name: 'Load next page' }));

    const retry = await screen.findByRole('button', { name: tr('retry') });
    expect(screen.getByText('First song')).toBeInTheDocument();
    expect(screen.getByText(tr('libraryLoadFailed'))).toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: tr('retry') })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load next page' }));
    expect(await screen.findByText('Second song')).toBeInTheDocument();
    expect(screen.getByText('First song')).toBeInTheDocument();
    expect(pythonClient.searchSongs).toHaveBeenLastCalledWith(
      expect.anything(),
      'page-2',
    );
  },
);
