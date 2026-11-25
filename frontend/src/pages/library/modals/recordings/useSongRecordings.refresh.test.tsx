import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecordingDto, SongDto } from '../../../../contracts/models';
import { recordingsChanged } from '../../../../services/backendEvents';
import { useSongRecordings } from './useSongRecordings';

const api = vi.hoisted(() => ({ listRecordings: vi.fn() }));
vi.mock('@neo-ui-kit/react', () => ({
  tr: (key: string) => key,
  useLocale: () => 'ru',
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('../../../../components/api-service', () => ({
  refreshSongs: vi.fn(),
}));
vi.mock('../../../../providers/store', () => ({
  store: { playback: { returned: null } },
}));
vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../../../services/pythonClient', () => ({ pythonClient: api }));
vi.mock('../../../../services/audioClient', () => ({ audioClient: {} }));
vi.mock('../../songs/useGuardedAction', () => ({
  useGuardedAction: () => (work: () => unknown) => work(),
}));

const song: SongDto = {
  id: 'song',
  title: 'Song',
  artist: 'Artist',
  language: 'Auto',
  status: 'ready',
  durationSeconds: 30,
  createdAt: '',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
};
const take: RecordingDto = {
  id: 'take',
  songId: song.id,
  filePath: '/take.flac',
  displayName: '',
  createdAt: '',
  durationSeconds: 30,
  sizeBytes: 1000,
  analyzed: false,
  fileStatus: 'Ready',
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  api.listRecordings.mockResolvedValue([]);
});
afterEach(() => vi.resetAllMocks());

it.each(['response', 'failure'] as const)(
  'refreshes after changes during a pending %s without waiting for another event',
  async (outcome) => {
    const pending = deferred<RecordingDto[]>();
    const handled = vi.fn();
    const analyzed = vi.fn();
    const { result } = renderHook(() =>
      useSongRecordings(song, handled, analyzed),
    );
    await waitFor(() => expect(result.current.loadingRecordings).toBe(false));
    api.listRecordings
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce([take]);

    act(recordingsChanged);
    for (let update = 0; update < 100; update++) act(recordingsChanged);
    expect(api.listRecordings).toHaveBeenCalledTimes(2);

    await act(async () => {
      if (outcome === 'response') pending.resolve([]);
      else pending.reject(new Error('The previous snapshot is unavailable'));
    });

    expect(api.listRecordings).toHaveBeenCalledTimes(3);
    expect(result.current.recordings).toEqual([take]);
  },
);

it.each(['close', 'unmount'] as const)(
  'does not retry an invalidated refresh after %s',
  async (leave) => {
    const pending = deferred<RecordingDto[]>();
    const handled = vi.fn();
    const analyzed = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSongRecordings(song, handled, analyzed),
    );
    await waitFor(() => expect(result.current.loadingRecordings).toBe(false));
    api.listRecordings.mockImplementationOnce(() => pending.promise);

    act(recordingsChanged);
    act(recordingsChanged);
    if (leave === 'close') act(() => result.current.close());
    else unmount();
    await act(async () => pending.resolve([take]));

    expect(api.listRecordings).toHaveBeenCalledTimes(2);
    expect(result.current.recordings).toEqual([]);
  },
);

it('keeps a refreshed gallery when the older initial open response arrives', async () => {
  const initial = deferred<RecordingDto[]>();
  api.listRecordings
    .mockImplementationOnce(() => initial.promise)
    .mockResolvedValue([take]);
  const handled = vi.fn();
  const analyzed = vi.fn();
  const { result } = renderHook(() =>
    useSongRecordings(song, handled, analyzed),
  );
  expect(result.current.loadingRecordings).toBe(true);

  await act(async () => recordingsChanged());
  expect(result.current.recordings).toEqual([take]);
  await act(async () => initial.resolve([]));

  expect(result.current.recordings).toEqual([take]);
  expect(result.current.loadingRecordings).toBe(false);
});

it.each(['close', 'unmount', 'switch-song'] as const)(
  'does not retry or publish an old initial read after %s',
  async (leave) => {
    const initial = deferred<RecordingDto[]>();
    const nextSong = { ...song, id: 'next-song' };
    const nextTake = { ...take, songId: nextSong.id, id: 'next-take' };
    api.listRecordings
      .mockImplementationOnce(() => initial.promise)
      .mockResolvedValue([]);
    const handled = vi.fn();
    const analyzed = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ requested }) => useSongRecordings(requested, handled, analyzed),
      { initialProps: { requested: song } },
    );
    await act(async () => recordingsChanged());
    if (leave === 'switch-song') {
      api.listRecordings.mockResolvedValue([nextTake]);
      await act(async () => rerender({ requested: nextSong }));
    } else if (leave === 'close') act(() => result.current.close());
    else unmount();
    const before = api.listRecordings.mock.calls.length;
    await act(async () => initial.resolve([take]));

    expect(api.listRecordings).toHaveBeenCalledTimes(before);
    expect(result.current.recordings).toEqual(
      leave === 'switch-song' ? [nextTake] : [],
    );
  },
);
