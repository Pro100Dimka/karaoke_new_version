import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProcessingJobDto, SongDto } from '../../../contracts/models';
import { libraryChanged } from '../../../services/backendEvents';
import { pythonClient } from '../../../services/pythonClient';
import { editorApi } from '../../editor/editorApi';
import LibrarySongs from './index';

const actions = vi.hoisted(() => ({
  confirmDelete: vi.fn(),
  retryProcessing: vi.fn(async () => true),
  resetLyricsAndReprocess: vi.fn(),
  reportProcessingError: vi.fn(),
  retrying: null,
  reporting: false,
}));
const jobState = vi.hoisted(() => ({ jobs: [] as ProcessingJobDto[] }));
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
  useJobs: () => jobState,
  useRoomLibraryCommands: () => null,
}));
vi.mock('../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../../services/pythonClient', () => ({
  pythonClient: {
    searchSongs: vi.fn(),
    listSongs: vi.fn(),
    getSong: vi.fn(),
    updateSong: vi.fn(),
    removeSongCover: vi.fn(),
  },
}));
vi.mock('../../editor/editorApi', () => ({
  editorApi: { load: vi.fn() },
}));
vi.mock('../modals/recordings', () => ({ RecordingsModal: () => null }));
vi.mock('../modals/settings', () => ({ openSettings: vi.fn() }));
vi.mock('./useSongActions', () => ({
  curtainMilliseconds: 400,
  useSongActions: () => actions,
}));
// Keep the catalog, cards, settings form and document query real; jsdom has no layout.
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

const initialSong: SongDto = {
  id: 'song',
  title: 'Original title',
  artist: 'Original artist',
  language: 'English',
  status: 'ready',
  durationSeconds: 180,
  createdAt: '2026-11-19T00:00:00Z',
  coverState: 'Fallback',
  activeRevision: 2,
  projectFormatVersion: 1,
  detectedBpm: 100,
};
let song: SongDto;
let client: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  jobState.jobs = [];
  song = initialSong;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryDefaults(['song-imports'], { queryFn: () => [] });
  vi.mocked(pythonClient.searchSongs).mockImplementation(
    async ({ status }) => ({
      items: status === 'all' || song.status === status ? [song] : [],
      nextCursor: null,
    }),
  );
  vi.mocked(pythonClient.getSong).mockImplementation(async () => song);
  vi.mocked(editorApi.load).mockImplementation(async () => ({
    revision: song.activeRevision,
    bpm: song.activeRevision === 2 ? 105 : 125,
    words: [],
    notes: [],
  }));
});
afterEach(() => client.clear());

const openSettings = async (status: SongDto['status'] | 'all' = 'all') => {
  render(
    <QueryClientProvider client={client}>
      <LibrarySongs
        playlistsOpen={false}
        onClosePlaylists={vi.fn()}
        onReady={vi.fn()}
        view={{
          query: '',
          filters: {
            status,
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
  fireEvent.click(
    await screen.findByRole('button', { name: tr('songSettings') }),
  );
  return within(screen.getByRole('dialog'));
};

it.each(['all', 'ready'] as const)(
  'updates an open form across refinement without discarding drafts (%s filter)',
  async (status) => {
    const dialog = await openSettings(status);
    await waitFor(() =>
      expect(
        dialog.getByRole('spinbutton', { name: tr('practiceSpeed') }),
      ).toHaveValue(105),
    );
    fireEvent.change(dialog.getByRole('textbox', { name: tr('title') }), {
      target: { value: 'My title draft' },
    });
    fireEvent.change(dialog.getByRole('textbox', { name: tr('artist') }), {
      target: { value: 'My artist draft' },
    });
    fireEvent.click(dialog.getByRole('button', { name: tr('realignLyrics') }));
    expect(actions.retryProcessing).toHaveBeenCalledWith(song.id, 'lyrics');

    song = { ...song, status: 'processing' };
    act(() => libraryChanged());
    await waitFor(() => {
      if (status === 'all')
        expect(
          within(screen.getByRole('listitem')).getByText(tr('processing')),
        ).toBeInTheDocument();
      else expect(screen.queryByRole('listitem')).toBeNull();
    });
    expect(
      dialog.getByRole('button', { name: tr('melodyEditor') }),
    ).toBeDisabled();
    expect(
      dialog.getByRole('button', { name: tr('realignLyrics') }),
    ).toBeDisabled();

    song = { ...song, status: 'ready', activeRevision: 3, detectedBpm: 120 };
    act(() => libraryChanged());
    await waitFor(() =>
      expect(
        dialog.getByRole('spinbutton', { name: tr('practiceSpeed') }),
      ).toHaveValue(125),
    );
    expect(editorApi.load).toHaveBeenCalledTimes(2);
    expect(
      dialog.getByRole('button', { name: tr('melodyEditor') }),
    ).toBeEnabled();
    expect(
      dialog.getByRole('button', { name: tr('realignLyrics') }),
    ).toBeEnabled();
    expect(dialog.getByRole('textbox', { name: tr('title') })).toHaveValue(
      'My title draft',
    );
    expect(dialog.getByRole('textbox', { name: tr('artist') })).toHaveValue(
      'My artist draft',
    );
    expect(pythonClient.listSongs).not.toHaveBeenCalled();
  },
);

it.each(['all', 'not-processed'] as const)(
  'unlocks an open imported-song form and loads its completed project (%s filter)',
  async (status) => {
    song = {
      ...initialSong,
      status: 'not-processed',
      activeRevision: 1,
      detectedBpm: undefined,
    };
    const dialog = await openSettings(status);
    expect(
      dialog.getByRole('button', { name: tr('melodyEditor') }),
    ).toBeDisabled();
    expect(editorApi.load).not.toHaveBeenCalled();

    song = { ...initialSong, activeRevision: 3, detectedBpm: 120 };
    act(() => libraryChanged());
    await waitFor(() => {
      if (status === 'all')
        expect(
          within(screen.getByRole('listitem')).getByText(tr('ready')),
        ).toBeInTheDocument();
      else expect(screen.queryByRole('listitem')).toBeNull();
    });

    expect(
      dialog.getByRole('button', { name: tr('melodyEditor') }),
    ).toBeEnabled();
    expect(
      dialog.getByRole('button', { name: tr('realignLyrics') }),
    ).toBeEnabled();
    await waitFor(() =>
      expect(
        dialog.getByRole('spinbutton', { name: tr('practiceSpeed') }),
      ).toHaveValue(125),
    );
    expect(editorApi.load).toHaveBeenCalledOnce();
    expect(pythonClient.listSongs).not.toHaveBeenCalled();
  },
);

it('honors a running refinement while the stored song remains Ready', async () => {
  const dialog = await openSettings('ready');
  await waitFor(() => expect(editorApi.load).toHaveBeenCalledOnce());
  jobState.jobs = [
    {
      id: 'lyrics-job',
      type: 'SongProcessing',
      songId: song.id,
      state: 'processing',
      stage: 'Alignment',
      progress: 20,
      timingOperation: 'lyrics',
    },
  ];
  act(() => libraryChanged());
  await waitFor(() =>
    expect(
      within(screen.getByRole('listitem')).getByText(tr('processing')),
    ).toBeInTheDocument(),
  );
  expect(song.status).toBe('ready');
  expect(
    dialog.getByRole('button', { name: tr('melodyEditor') }),
  ).toBeDisabled();
  expect(
    dialog.getByRole('button', { name: tr('realignLyrics') }),
  ).toBeDisabled();

  jobState.jobs = [];
  song = { ...song, activeRevision: 3 };
  act(() => libraryChanged());
  await waitFor(() =>
    expect(
      dialog.getByRole('spinbutton', { name: tr('practiceSpeed') }),
    ).toHaveValue(125),
  );
  expect(
    dialog.getByRole('button', { name: tr('melodyEditor') }),
  ).toBeEnabled();
  expect(
    dialog.getByRole('button', { name: tr('realignLyrics') }),
  ).toBeEnabled();
  expect(pythonClient.listSongs).not.toHaveBeenCalled();
});
