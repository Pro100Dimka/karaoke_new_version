import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProcessingJobDto } from '../contracts/models';
import { pythonClient } from '../services/pythonClient';
import { subscribeApplication } from './application';
import { store } from './store';
import { jobQuery } from '../components/api-service';
import type { JobProgress } from '../utils/contracts';

vi.mock('../services/pythonClient', () => ({
  pythonClient: { listJobs: vi.fn() },
}));
vi.mock('../services/audioClient', () => ({ audioClient: {} }));
vi.mock('../services/roomClient', () => ({ roomClient: {} }));
vi.mock('../services/desktopClient', () => ({
  desktopClient: { setAppIcon: vi.fn() },
}));
vi.mock('../shared/preferences/appFonts', async (original) => ({
  ...(await original<typeof import('../shared/preferences/appFonts')>()),
  applyAppFonts: vi.fn(),
}));

const job = (
  progress: number,
  state: ProcessingJobDto['state'] = 'processing',
  id = 'job',
): ProcessingJobDto => ({
  id,
  type: 'SongProcessing',
  songId: `song-${id}`,
  state,
  progress,
  stage: 'melody',
  processingBackend: 'Local',
});
const event = (progress: number, state = 'Running', id = 'job') => ({
  type: 'job.changed',
  data: {
    jobId: id,
    type: 'SongProcessing',
    entityId: `song-${id}`,
    state,
    stage: 'melody',
    stageProgress: progress / 100,
    overallProgress: progress / 100,
  },
});
const listeners = new Set<(value: unknown) => void>();
const push = (value: unknown) => {
  for (const listener of [...listeners]) listener(value);
};
let requests: {
  resolve(value: ProcessingJobDto[]): void;
  reject(error: Error): void;
}[];
let inFlight: number;
let maximumInFlight: number;
let client: QueryClient;
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
  vi.clearAllMocks();
  requests = [];
  inFlight = maximumInFlight = 0;
  Object.assign(window, {
    desktop: {
      onBackendEvent: (listener: (value: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  vi.mocked(pythonClient.listJobs).mockImplementation(() => {
    inFlight++;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    return new Promise<ProcessingJobDto[]>((resolve, reject) =>
      requests.push({ resolve, reject }),
    ).finally(() => {
      inFlight--;
    });
  });
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, networkMode: 'always' },
    },
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  client.clear();
  Reflect.deleteProperty(window, 'desktop');
  listeners.clear();
  vi.useRealTimers();
});
const finish = async (index: number, value: ProcessingJobDto[]) => {
  requests[index]!.resolve(value);
  await vi.advanceTimersByTimeAsync(1);
};

it('refreshes known jobs without rereading the completed history on every progress event', async () => {
  const archived = Array.from({ length: 1000 }, (_, index) =>
    job(100, 'completed', `archived-${index}`),
  );
  const values = new Map(
    [job(0), ...archived].map((value) => [value.id, value]),
  );
  let transferredRows = 0;
  const list = vi.mocked(pythonClient.listJobs);
  list.mockImplementation(async (ids?: readonly string[]) => {
    const result = ids
      ? ids.map((id) => values.get(id)!)
      : [...values.values()];
    transferredRows += result.length;
    return result;
  });
  stop = subscribeApplication(client);
  await vi.advanceTimersByTimeAsync(1);
  expect(client.getQueryData<ProcessingJobDto[]>(['jobs'])).toHaveLength(1001);
  list.mockClear();
  transferredRows = 0;

  for (let tick = 1; tick <= 3; tick++) {
    values.set('job', job(tick * 10));
    for (let burst = 0; burst < 20; burst++) push(event(tick * 10));
    await vi.advanceTimersByTimeAsync(250);
  }

  expect.soft(transferredRows).toBe(3);
  expect
    .soft(list.mock.calls.map(([ids]) => ids))
    .toEqual([['job'], ['job'], ['job']]);
  const shown = client.getQueryData<ProcessingJobDto[]>(['jobs'])!;
  expect(shown).toHaveLength(1001);
  expect(shown[0]?.progress).toBe(30);
  expect(shown.slice(1)).toEqual(archived);
  expect(shown.at(-1)).toBe(archived.at(-1));
});

it('keeps manual invalidation authoritative when a known progress event is pending', async () => {
  let values = [job(0), job(100, 'completed', 'history')];
  const list = vi.mocked(pythonClient.listJobs);
  list.mockImplementation(async (ids) =>
    ids ? values.filter((value) => ids.includes(value.id)) : values,
  );
  stop = subscribeApplication(client);
  await vi.advanceTimersByTimeAsync(1);
  list.mockClear();

  // A processing action invalidates the history before the new job's creation
  // event necessarily arrives. A different known job must not narrow that read.
  push(event(10));
  values = [job(0, 'queued', 'new'), job(10), values[1]!];
  await client.invalidateQueries({ queryKey: ['jobs'] });

  expect(list.mock.calls.map(([ids]) => ids)).toEqual([undefined]);
  expect(client.getQueryData(['jobs'])).toEqual(values);
});

it.each([false, true])(
  'publishes completed job reads during continuous progress (cached: %s)',
  async (cached) => {
    if (cached) client.setQueryData(['jobs'], [job(0)]);
    stop = subscribeApplication(client);
    const displayed: (number | undefined)[] = [];
    for (let tick = 1; tick <= 3; tick++) {
      for (let burst = 0; burst < 10; burst++) push(event(tick * 10));
      await vi.advanceTimersByTimeAsync(250);
      await finish(tick - 1, [job(tick * 10)]);
      displayed.push(
        client.getQueryData<ProcessingJobDto[]>(['jobs'])?.[0]?.progress,
      );
    }
    expect(displayed).toEqual([10, 20, 30]);
    expect(store.application.localProcessing).toBe(true);
    expect(maximumInFlight).toBe(1);
    expect(requests.length).toBe(4);
    await finish(3, [job(30)]);
    expect(client.getQueryState(['jobs'])?.fetchStatus).toBe('idle');
    expect(requests.length).toBe(4);
  },
);

it.each([
  {
    current: 'processing' as const,
    pushed: 'Running',
    stale: 'queued' as const,
    progress: 20,
  },
  {
    current: 'completed' as const,
    pushed: 'Succeeded',
    stale: 'processing' as const,
    progress: 100,
  },
])(
  'does not regress $current to $stale when an old response follows a state event',
  async ({ current, pushed, stale, progress }) => {
    client.setQueryData(['jobs'], [job(progress, current)]);
    stop = subscribeApplication(client);
    push(event(progress, pushed));
    await vi.advanceTimersByTimeAsync(250);
    await finish(0, [job(0, stale)]);
    expect(client.getQueryData<ProcessingJobDto[]>(['jobs'])?.[0]?.state).toBe(
      current,
    );
    await finish(1, [job(progress, current)]);
    expect(client.getQueryData<ProcessingJobDto[]>(['jobs'])).toEqual([
      job(progress, current),
    ]);
    expect(maximumInFlight).toBe(1);
  },
);

it('keeps new jobs behind a structural barrier until the snapshot includes their latest state', async () => {
  client.setQueryData(['jobs'], [job(100, 'completed', 'old')]);
  stop = subscribeApplication(client);
  push(event(0, 'Queued', 'new'));
  await vi.advanceTimersByTimeAsync(250);
  await finish(0, [job(100, 'completed', 'old')]);
  expect(
    client.getQueryData<ProcessingJobDto[]>(['jobs'])?.map(({ id }) => id),
  ).toEqual(['old']);
  push(event(10, 'Running', 'new'));
  await vi.advanceTimersByTimeAsync(250);
  await finish(1, [job(0, 'queued', 'new'), job(100, 'completed', 'old')]);
  expect(
    client.getQueryData<ProcessingJobDto[]>(['jobs'])?.map(({ id }) => id),
  ).toEqual(['old']);
  await finish(2, [job(10, 'processing', 'new'), job(100, 'completed', 'old')]);
  expect(client.getQueryData<ProcessingJobDto[]>(['jobs'])?.[0]).toEqual(
    job(10, 'processing', 'new'),
  );
  expect(maximumInFlight).toBe(1);
});

it.each(['connected', 'resync'])(
  'reconciles deletions after %s and releases all listeners on unsubscribe',
  async (type) => {
    client.setQueryData(['jobs'], [job(100, 'completed')]);
    stop = subscribeApplication(client);
    push({ type });
    await vi.advanceTimersByTimeAsync(250);
    await finish(0, [job(100, 'completed')]);
    await finish(1, []);
    expect(client.getQueryData(['jobs'])).toEqual([]);
    stop();
    stop = undefined;
    expect(listeners.size).toBe(0);
    push(event(10));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests.length).toBe(2);
  },
);

it('does not retry or publish an in-flight read after cancellation and unsubscribe', async () => {
  client.setQueryData(['jobs'], [job(5)]);
  stop = subscribeApplication(client);
  push(event(10));
  await vi.advanceTimersByTimeAsync(250);
  await client.cancelQueries({ queryKey: ['jobs'] });
  stop();
  stop = undefined;
  expect(listeners.size).toBe(0);
  await finish(0, [job(10)]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(client.getQueryData<ProcessingJobDto[]>(['jobs'])?.[0]?.progress).toBe(
    5,
  );
  expect(requests.length).toBe(1);
});

it('does not schedule a trailing refresh after the in-flight read fails', async () => {
  client.setQueryData(['jobs'], [job(5)]);
  stop = subscribeApplication(client);
  push(event(10));
  await vi.advanceTimersByTimeAsync(250);
  const error = new Error('Read failed');
  requests[0]!.reject(error);
  await vi.advanceTimersByTimeAsync(1);
  expect(client.getQueryState(['jobs'])?.error).toBe(error);
  expect(client.getQueryData<ProcessingJobDto[]>(['jobs'])?.[0]?.progress).toBe(
    5,
  );
  expect(requests).toHaveLength(1);
  stop();
  stop = undefined;
  expect(listeners.size).toBe(0);
});

it('drops a scheduled trailing refresh when the application subscription ends', async () => {
  client.setQueryData(['jobs'], [job(5)]);
  stop = subscribeApplication(client);
  push(event(10));
  await vi.advanceTimersByTimeAsync(250);
  let stopPublished = () => undefined as void;
  const published = new Promise<void>((resolve) => {
    stopPublished = client.getQueryCache().subscribe((change) => {
      if (
        change.type === 'updated' &&
        change.query.queryKey[0] === 'jobs' &&
        change.action.type === 'success'
      )
        resolve();
    });
  });
  requests[0]!.resolve([job(10)]);
  await published;
  stopPublished();
  expect(client.getQueryData<ProcessingJobDto[]>(['jobs'])?.[0]?.progress).toBe(
    10,
  );
  stop();
  stop = undefined;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(requests).toHaveLength(1);
  expect(listeners.size).toBe(0);
});

it('coalesces active targeted job refreshes without cancelling their in-flight transport', async () => {
  const key = ['job', 'SongProcessing', 'song-job'];
  const value = (progress: number): JobProgress => ({
    jobId: 'job',
    entityId: 'song-job',
    state: 'Running',
    stage: 'melody',
    stageProgress: progress / 100,
    overallProgress: progress / 100,
  });
  const reads: ((body: unknown) => void)[] = [];
  let activeReads = 0;
  let maximum = 0;
  Object.assign(window.desktop!, {
    pythonRequest: () => {
      activeReads++;
      maximum = Math.max(maximum, activeReads);
      return new Promise((resolve) =>
        reads.push((body) => {
          activeReads--;
          resolve({ ok: true, status: 200, body });
        }),
      );
    },
  });
  client.setQueryData(key, value(0));
  const observer = new QueryObserver(
    client,
    jobQuery('SongProcessing', 'song-job'),
  );
  const unsubscribe = observer.subscribe(() => undefined);
  stop = subscribeApplication(client);
  try {
    const displayed: (number | undefined)[] = [];
    for (let tick = 1; tick <= 3; tick++) {
      for (let burst = 0; burst < 10; burst++) push(event(tick * 10));
      await vi.advanceTimersByTimeAsync(250);
      expect(reads).toHaveLength(tick);
      reads[tick - 1]!({ items: [value(tick * 10)] });
      await vi.advanceTimersByTimeAsync(1);
      displayed.push(client.getQueryData<JobProgress>(key)?.overallProgress);
    }
    expect(displayed).toEqual([0.1, 0.2, 0.3]);
    expect(maximum).toBe(1);
    expect(reads).toHaveLength(4);
    reads[3]!({ items: [value(30)] });
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveLength(4);
    expect(client.getQueryState(key)?.fetchStatus).toBe('idle');
  } finally {
    unsubscribe();
    observer.destroy();
  }
});
