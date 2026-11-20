import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProcessingJobDto, SongDto } from '../../../contracts/models';
import { NotificationsProvider } from '../../../providers/notifications';
import { store } from '../../../providers/store';
import '../../../providers/localization';
import { clearStorage } from '../../../shared/storage/localStore';
import { ProcessingModal } from '../modals/processing';
import { SongCard } from './song-grid/song-card';

const api = vi.hoisted(() => ({
  revealProject: vi.fn(),
  listSongs: vi.fn(),
  diagnostics: vi.fn(),
  jobs: [] as ProcessingJobDto[],
}));
vi.mock('../../../services/desktopClient', () => ({ desktopClient: api }));
vi.mock('../../../services/pythonClient', () => ({ pythonClient: api }));
vi.mock('../../../providers/application', () => ({
  useJobs: () => ({ jobs: api.jobs, failed: false }),
}));
// jsdom has no layout; keep the actual queue, cards, menu and action handlers.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 150,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 150,
      })),
    measureElement: vi.fn(),
    options: { scrollMargin: 0 },
    scrollToIndex: vi.fn(),
  }),
}));

const song: SongDto = {
  id: 'imported-song',
  title: 'Imported song',
  artist: 'Singer',
  language: 'English',
  status: 'not-processed',
  durationSeconds: 60,
  createdAt: '2026-11-20T00:00:00Z',
  coverState: 'Fallback',
  activeRevision: 0,
  projectFormatVersion: 1,
};
let client: QueryClient;
const preferences = store.preferences;
beforeEach(() => {
  vi.resetAllMocks();
  clearStorage();
  store.updatePreferences({ language: 'ru', notificationVolume: 0 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['song-imports'], []);
  api.listSongs.mockResolvedValue([song]);
  api.diagnostics.mockResolvedValue({
    storage: {
      songs: 0,
      models: 0,
      cache: 0,
      recordings: 0,
      temp: 0,
      free: 100,
    },
  });
  api.jobs = [
    {
      id: 'completed-import',
      type: 'SongImport',
      songId: song.id,
      state: 'completed',
      stage: 'Complete',
      progress: 100,
    },
  ];
  api.revealProject.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  client.clear();
  store.updatePreferences(preferences);
  clearStorage();
});

it.each(['song card', 'processing queue'] as const)(
  'reports a rejected folder request from the %s and permits a later retry',
  async (surface) => {
    // This is the rejected IPC promise returned when shell.openPath cannot open
    // the imported song directory. Observe it here so RED tests fail on the UI
    // assertion without an additional harness-level unhandled rejection.
    const refusal = Promise.reject(
      new Error('The system cannot find the path specified.'),
    );
    void refusal.catch(() => undefined);
    api.revealProject.mockReturnValueOnce(refusal);
    render(
      <QueryClientProvider client={client}>
        <NotificationsProvider>
          {surface === 'song card' ? (
            <SongCard
              song={song}
              onPlay={vi.fn()}
              onOpenProcessing={vi.fn()}
              onOpenSettings={vi.fn()}
              onOpenRecordings={vi.fn()}
            />
          ) : (
            <ProcessingModal open onClose={vi.fn()} onPlay={vi.fn()} />
          )}
        </NotificationsProvider>
      </QueryClientProvider>,
    );
    const open = async () => {
      if (surface === 'processing queue') {
        await waitFor(() => expect(api.listSongs).toHaveBeenCalled());
        fireEvent.click(
          await screen.findByRole('button', {
            name: tr('processingJobActions'),
          }),
        );
        fireEvent.click(
          await screen.findByRole('menuitem', { name: tr('openFolder') }),
        );
      } else
        fireEvent.click(screen.getByRole('button', { name: tr('openFolder') }));
    };

    await open();
    await waitFor(() =>
      expect(api.revealProject).toHaveBeenCalledExactlyOnceWith(song.id, 0),
    );
    expect(await screen.findByText(tr('actionFailed'))).toBeVisible();

    await open();
    await waitFor(() => expect(api.revealProject).toHaveBeenCalledTimes(2));
    expect(api.revealProject).toHaveBeenLastCalledWith(song.id, 0);
    expect(screen.getAllByText(tr('actionFailed'))).toHaveLength(1);
  },
);
