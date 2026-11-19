import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../contracts/models';
import { DialogView } from '../../../providers/dialog';
import { pythonClient } from '../../../services/pythonClient';
import LibrarySongs from './index';

const server = vi.hoisted(() => ({ songs: [] as SongDto[] }));
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
  pythonClient: {
    listSongs: vi.fn(async () => server.songs),
    searchSongs: vi.fn(async () => ({ items: server.songs, nextCursor: null })),
    listRecordings: vi.fn(async () => []),
    deleteSong: vi.fn(async (id: string) => {
      server.songs = server.songs.filter((song) => song.id !== id);
    }),
  },
}));
vi.mock('../modals/recordings', () => ({ RecordingsModal: () => null }));

let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  server.songs = ['first', 'second'].map((id) => ({
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
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // jsdom has no layout engine; the real virtual grid receives a visible window.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  for (const property of [
    'offsetWidth',
    'offsetHeight',
    'clientWidth',
  ] as const)
    vi.spyOn(HTMLElement.prototype, property, 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 600, 600),
  );
});
afterEach(() => {
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('clears a selected song after deleting it through its own card', async () => {
  render(
    <QueryClientProvider client={client}>
      <DialogView />
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
        pageRef={{ current: document.body }}
        onPlay={vi.fn()}
        songSelection={() => undefined}
      />
    </QueryClientProvider>,
  );
  const firstCard = await screen.findByRole('listitem', {
    name: 'Singer - first',
  });
  fireEvent.click(within(firstCard).getByRole('checkbox'));
  await waitFor(() =>
    expect(within(firstCard).getByRole('checkbox')).not.toBeDisabled(),
  );
  expect(
    screen.getByRole('button', { name: tr('cancel') }),
  ).toBeInTheDocument();
  fireEvent.click(
    within(firstCard).getByRole('button', { name: tr('deleteSong') }),
  );
  const confirmation = await screen.findByRole('dialog', {
    name: tr('deleteSongTitle', { value: 'first' }),
  });
  fireEvent.click(
    within(confirmation).getByRole('button', { name: tr('deleteSong') }),
  );

  await waitFor(() =>
    expect(pythonClient.deleteSong).toHaveBeenCalledWith('first'),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('listitem', { name: 'Singer - first' }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole('button', { name: tr('cancel') }),
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByRole('listitem', { name: 'Singer - second' })).getByRole(
      'button',
      { name: tr('play') },
    ),
  ).not.toBeDisabled();
});
