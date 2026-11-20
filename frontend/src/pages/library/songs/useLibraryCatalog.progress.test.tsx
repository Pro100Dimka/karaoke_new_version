import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProcessingJobDto, SongDto } from '../../../contracts/models';
import { store } from '../../../providers/store';
import { pythonClient } from '../../../services/pythonClient';
import { selectLibrarySongs } from './librarySelectors';
import { useLibraryCatalog } from './useLibraryCatalog';

const state = vi.hoisted(() => ({ jobs: [] as ProcessingJobDto[] }));
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
      librarySort: 'title',
      librarySortDirection: 'asc',
      karaokePlaylists: [],
    },
    application: { services: { pythonEpoch: 0 } },
  },
}));
vi.mock('../../../providers/application', () => ({
  useJobs: () => state,
}));
vi.mock('./librarySelectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./librarySelectors')>();
  return { ...actual, selectLibrarySongs: vi.fn(actual.selectLibrarySongs) };
});

const filters = {
  status: 'all',
  language: 'all',
  duration: 'all',
  artwork: 'all',
} as const;
const song = (id: string, title = id): SongDto => ({
  id,
  title,
  artist: 'Singer',
  language: 'English',
  status: 'ready',
  durationSeconds: 180,
  createdAt: '2026-01-01',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
});
const job = (id: string): ProcessingJobDto => ({
  id: `job-${id}`,
  type: 'SongProcessing',
  songId: id,
  state: 'processing',
  stage: 'melody',
  progress: 0,
});
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.jobs = [job('song-0')];
  store.online.room = null;
  store.preferences.librarySort = 'title';
  store.preferences.librarySortDirection = 'asc';
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryDefaults(['song-imports'], { queryFn: async () => [] });
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});

it('updates live progress without filtering and sorting the complete catalog again', async () => {
  const songs = Array.from({ length: 2000 }, (_, index) =>
    song(`song-${index}`, `Песня ${index}`),
  );
  vi.mocked(pythonClient.listSongs).mockResolvedValue(songs);
  const { result, rerender } = renderHook(
    () => useLibraryCatalog('', filters, true),
    { wrapper },
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(result.current.visibleSongs).toHaveLength(songs.length);
  const order = result.current.visibleSongs.map(({ id }) => id);
  const unchanged = result.current.visibleSongs.find(
    ({ id }) => id === 'song-1',
  );
  vi.mocked(selectLibrarySongs).mockClear();
  for (let tick = 1; tick <= 20; tick++) {
    state.jobs = [
      { ...state.jobs[0]!, progress: tick / 20, stage: `melody ${tick}` },
    ];
    rerender();
    for (const list of [
      result.current.localSongs,
      result.current.songs,
      result.current.visibleSongs,
    ]) {
      expect(list.find(({ id }) => id === 'song-0')).toMatchObject({
        progress: tick / 20,
        stage: `melody ${tick}`,
        status: 'processing',
        jobId: 'job-song-0',
      });
    }
  }
  expect(result.current.visibleSongs.map(({ id }) => id)).toEqual(order);
  expect(result.current.visibleSongs.find(({ id }) => id === 'song-1')).toBe(
    unchanged,
  );
  expect(selectLibrarySongs).not.toHaveBeenCalled();
});

it('still refilters changes in job state, identity and edited song metadata', async () => {
  state.jobs = [{ ...job('song-0'), state: 'queued' }];
  vi.mocked(pythonClient.listSongs).mockResolvedValue([
    song('song-0', 'Zulu'),
    song('song-1', 'Alpha'),
  ]);
  const { result, rerender } = renderHook(
    () => useLibraryCatalog('', { ...filters, status: 'processing' }, true),
    { wrapper },
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(result.current.visibleSongs).toEqual([]);
  state.jobs = [job('song-0')];
  rerender();
  expect(result.current.visibleSongs.map(({ id }) => id)).toEqual(['song-0']);
  state.jobs = [
    { ...job('song-0'), id: 'replacement', progress: 0.75, stage: 'lyrics' },
  ];
  rerender();
  expect(result.current.visibleSongs[0]).toMatchObject({
    jobId: 'replacement',
    progress: 0.75,
    stage: 'lyrics',
  });
  vi.mocked(pythonClient.listSongs).mockResolvedValue([
    song('song-0', 'Edited'),
    song('song-1', 'Alpha'),
  ]);
  await act(async () => {
    await result.current.catalog.refetch();
  });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(result.current.visibleSongs[0]?.title).toBe('Edited');
  state.jobs = [{ ...state.jobs[0]!, songId: 'song-1' }];
  rerender();
  expect(result.current.visibleSongs.map(({ id }) => id)).toEqual(['song-1']);
  state.jobs = [{ ...state.jobs[0]!, state: 'completed' }];
  rerender();
  expect(result.current.visibleSongs).toEqual([]);
});

it('keeps server page ordering while applying the latest progress', async () => {
  vi.mocked(pythonClient.searchSongs).mockResolvedValue({
    items: [song('song-0', 'Zulu'), song('song-1', 'Alpha')],
    nextCursor: 'next',
  });
  const { result, rerender } = renderHook(
    () => useLibraryCatalog('', filters, false),
    { wrapper },
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  state.jobs = [{ ...state.jobs[0]!, progress: 0.8 }];
  rerender();
  expect(result.current.visibleSongs.map(({ id }) => id)).toEqual([
    'song-0',
    'song-1',
  ]);
  expect(result.current.visibleSongs[0]?.progress).toBe(0.8);
  expect(result.current.catalog.hasNextPage).toBe(true);
});

it('does not add local progress to a ready room copy that replaced the processing song', async () => {
  store.online.room = {
    participants: [{ id: 'self', self: true }],
    sharedSongs: [
      {
        songId: 'song-0',
        title: 'Remote',
        artist: 'Singer',
        durationSeconds: 180,
        revision: 2,
        ownerParticipantId: 'other',
      },
    ],
  } as NonNullable<typeof store.online.room>;
  vi.mocked(pythonClient.listSongs).mockResolvedValue([song('song-0')]);
  const { result, rerender } = renderHook(
    () => useLibraryCatalog('', filters, false),
    { wrapper },
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  state.jobs = [{ ...state.jobs[0]!, progress: 0.8, stage: 'lyrics' }];
  rerender();
  expect(result.current.localSongs[0]).toMatchObject({
    progress: 0.8,
    stage: 'lyrics',
    status: 'processing',
  });
  expect(result.current.visibleSongs[0]).toMatchObject({
    title: 'Remote',
    status: 'ready',
    roomOwnerId: 'other',
  });
  expect(result.current.visibleSongs[0]?.progress).toBeUndefined();
  expect(result.current.songs[0]?.jobId).toBeUndefined();
});
