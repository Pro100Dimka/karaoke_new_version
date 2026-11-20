import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JobProgress } from '../utils/contracts';
import { jobQuery } from './api-service';

const listeners = new Set<(value: unknown) => void>();
const push = (value: unknown) => {
  for (const listener of [...listeners]) listener(value);
};
const job = (
  progress: number,
  state = 'Running',
  jobId = 'model-job',
): JobProgress => ({
  jobId,
  entityId: 'model:1',
  state,
  stage: 'Download',
  stageProgress: progress,
  overallProgress: progress,
});
const change = (value: JobProgress, type = 'ModelDownload') => ({
  type: 'job.changed',
  data: { ...value, type },
});
let requests: ((body: unknown) => void)[];
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  Object.assign(window, {
    desktop: {
      pythonRequest: () =>
        new Promise((resolve) => {
          requests.push((body) => resolve({ ok: true, status: 200, body }));
        }),
      onBackendEvent: (listener: (value: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
});
afterEach(() => {
  client.clear();
  listeners.clear();
  Reflect.deleteProperty(window, 'desktop');
  vi.useRealTimers();
});
const finish = async (index: number, items: JobProgress[]) => {
  requests[index]!({ items });
  await vi.advanceTimersByTimeAsync(0);
};

it.each(['other type', 'other entity', 'same job progress'])(
  'publishes the targeted snapshot during %s events',
  async (scenario) => {
    const published = vi.fn();
    const pending = client
      .fetchQuery(jobQuery('ModelDownload', 'model:1'))
      .then(published, () => undefined);
    for (let tick = 1; tick <= 3; tick++) {
      const changed =
        scenario === 'other entity'
          ? { ...job(tick / 10, 'Running', 'other'), entityId: 'other:1' }
          : job(tick / 10);
      push(
        change(
          changed,
          scenario === 'other type' ? 'SongProcessing' : 'ModelDownload',
        ),
      );
    }
    await finish(0, [job(0.3)]);
    expect(published).toHaveBeenCalledWith(job(0.3));
    expect(requests).toHaveLength(1);
    expect(listeners.size).toBe(0);
    await pending;
  },
);

it.each([
  ['Running', 'Queued'],
  ['Succeeded', 'Running'],
])(
  'rejects a stale %s -> %s response until the current state is read',
  async (state, stale) => {
    const published = vi.fn();
    const pending = client
      .fetchQuery(jobQuery('ModelDownload', 'model:1'))
      .then(published, () => undefined);
    push(change(job(0.3, state)));
    await finish(0, [job(0, stale)]);
    expect(published).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    await finish(1, [job(0.3, state)]);
    expect(published).toHaveBeenCalledWith(job(0.3, state));
    expect(requests).toHaveLength(2);
    await pending;
  },
);

it('reconciles a new job and a resync deletion without publishing the stale result', async () => {
  const published = vi.fn();
  const pending = client
    .fetchQuery(jobQuery('ModelDownload', 'model:1'))
    .then(published, () => undefined);
  push(change(job(0, 'Queued', 'new')));
  await finish(0, [job(1, 'Succeeded')]);
  expect(published).not.toHaveBeenCalled();
  push({ type: 'resync' });
  await finish(1, [job(0, 'Queued', 'new')]);
  expect(published).not.toHaveBeenCalled();
  await finish(2, []);
  expect(published).toHaveBeenCalledWith(null);
  expect(listeners.size).toBe(0);
  await pending;
});

it('releases the event listener immediately on cancellation and never retries the old response', async () => {
  const pending = client
    .fetchQuery(jobQuery('ModelDownload', 'model:1'))
    .catch(() => undefined);
  push(change(job(0.3)));
  await client.cancelQueries({ queryKey: ['job'] });
  expect(listeners.size).toBe(0);
  await finish(0, [job(0.3)]);
  expect(
    client.getQueryData(['job', 'ModelDownload', 'model:1']),
  ).toBeUndefined();
  expect(requests).toHaveLength(1);
  await pending;
});

it('keeps a fresh-read barrier for incomplete changes even when the job state appears unchanged', async () => {
  const published = vi.fn();
  const pending = client
    .fetchQuery(jobQuery('ModelDownload', 'model:1'))
    .then(published, () => undefined);
  push({
    type: 'job.changed',
    data: { jobId: 'model-job', type: 'ModelDownload', entityId: 'model:1' },
  });
  await finish(0, [job(0.1)]);
  expect(published).not.toHaveBeenCalled();
  await finish(1, [job(0.2)]);
  expect(published).toHaveBeenCalledWith(job(0.2));
  await pending;
});

it('surfaces a failed read instead of looping on progress events and releases its listener', async () => {
  const failed = vi.fn();
  const pending = client
    .fetchQuery(jobQuery('ModelDownload', 'model:1'))
    .catch(failed);
  push(change(job(0.3)));
  requests[0]!({ items: null });
  await vi.advanceTimersByTimeAsync(0);
  expect(failed).toHaveBeenCalledOnce();
  expect(requests).toHaveLength(1);
  expect(listeners.size).toBe(0);
  await pending;
});
