import {
  QueryClient,
  QueryObserver,
  type QueryKey,
} from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { refreshSongs } from './api-service';

let client: QueryClient;
const stop: (() => void)[] = [];
const settle = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  stop.splice(0).forEach((unsubscribe) => unsubscribe());
  client.clear();
  vi.useRealTimers();
});

const watch = (queryKey: QueryKey) => {
  const requests: {
    signal: AbortSignal;
    resolve(value: string): void;
    reject(error: Error): void;
  }[] = [];
  client.setQueryData(queryKey, 'initial');
  const observer = new QueryObserver(client, {
    queryKey,
    staleTime: Infinity,
    queryFn: ({ signal }) =>
      new Promise<string>((resolve, reject) => {
        requests.push({ signal, resolve, reject });
      }),
  });
  stop.push(observer.subscribe(() => undefined));
  return { observer, requests, data: () => client.getQueryData(queryKey) };
};

it('keeps one read in flight during a change burst and follows it with the newest revision', async () => {
  const songs = watch(['songs', 0, null]);
  const summary = watch(['song-summary', 0]);
  const first = refreshSongs(client);
  await settle();
  expect(songs.requests).toHaveLength(1);
  expect(summary.requests).toHaveLength(1);
  const burst = Array.from({ length: 30 }, () => refreshSongs(client));
  await settle();
  expect(songs.requests).toHaveLength(1);
  expect(summary.requests).toHaveLength(1);
  expect(songs.requests[0]?.signal.aborted).toBe(false);
  songs.requests[0]!.resolve('intermediate songs');
  summary.requests[0]!.resolve('intermediate summary');
  await settle();
  expect(songs.data()).toBe('intermediate songs');
  expect(songs.requests).toHaveLength(2);
  expect(summary.requests).toHaveLength(2);
  songs.requests[1]!.resolve('current songs');
  summary.requests[1]!.resolve('current summary');
  await Promise.all([first, ...burst]);
  expect(songs.data()).toBe('current songs');
  expect(summary.data()).toBe('current summary');
});

it('refreshes again when the first change arrives during an older background read', async () => {
  const songs = watch(['songs', 0, null]);
  const old = songs.observer.refetch();
  await settle();
  const changed = refreshSongs(client);
  await settle();
  expect(songs.requests).toHaveLength(1);
  expect(songs.requests[0]?.signal.aborted).toBe(false);
  songs.requests[0]!.resolve('before change');
  await old;
  await settle();
  expect(songs.requests).toHaveLength(2);
  songs.requests[1]!.resolve('after change');
  await changed;
  expect(songs.data()).toBe('after change');
});

it('does not restart a removed catalog or invalidate the replacement session', async () => {
  const old = watch(['songs', 0, null]);
  const first = refreshSongs(client);
  await settle();
  const trailing = refreshSongs(client);
  client.removeQueries({ queryKey: ['songs', 0] });
  const current = watch(['songs', 1, null]);
  await settle();
  expect(current.requests).toHaveLength(0);
  await Promise.all([first, trailing]);
  old.requests[0]!.resolve('stale response');
  await settle();
  expect(old.requests).toHaveLength(1);
  expect(current.requests).toHaveLength(0);
  expect(current.data()).toBe('initial');
  expect(client.getQueryData(['songs', 0, null])).toBeUndefined();
});

it('releases the refresh after failure so the next change can recover', async () => {
  const songs = watch(['songs', 0, null]);
  const failed = refreshSongs(client);
  await settle();
  songs.requests[0]!.reject(new Error('backend unavailable'));
  await failed;
  expect(songs.data()).toBe('initial');
  const retry = refreshSongs(client);
  await settle();
  expect(songs.requests).toHaveLength(2);
  songs.requests[1]!.resolve('recovered');
  await retry;
  expect(songs.data()).toBe('recovered');
});

it('invalidates inactive search caches without starting their requests', async () => {
  const key = ['songs', 0, { query: 'Queen' }];
  client.setQueryData(key, 'cached');
  await refreshSongs(client);
  expect(client.getQueryData(key)).toBe('cached');
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  expect(client.getQueryState(key)?.fetchStatus).toBe('idle');
});
