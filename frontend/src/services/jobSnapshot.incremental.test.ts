import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProcessingJobDto } from '../contracts/models';
import { onJobChange } from './backendEvents';
import { createJobSnapshotReader } from './jobSnapshot';

type Jobs = readonly ProcessingJobDto[];
type PendingRead = {
  ids: readonly string[] | undefined;
  signal: AbortSignal | undefined;
  resolve(value: Jobs): void;
  reject(error: unknown): void;
};
const job = (
  id: string,
  progress = 0,
  state: ProcessingJobDto['state'] = 'processing',
): ProcessingJobDto => ({
  id,
  type: 'SongProcessing',
  songId: `song-${id}`,
  songTitle: `Title ${id}`,
  songArtist: `Artist ${id}`,
  state,
  stage: 'melody',
  progress,
  processingBackend: 'Local',
  timingOperation: 'lyrics',
});
const backendStates = {
  queued: 'Queued',
  processing: 'Running',
  cancelling: 'Cancelling',
  completed: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
} as const;
const listeners = new Set<(value: unknown) => void>();
const stops: (() => void)[] = [];
const controllers: AbortController[] = [];
const push = (event: unknown) => {
  for (const listener of [...listeners]) listener(event);
};
const changed = (
  id: string,
  progress = 20,
  state: ProcessingJobDto['state'] = 'processing',
) =>
  push({
    type: 'job.changed',
    data: {
      jobId: id,
      type: 'SongProcessing',
      entityId: `song-${id}`,
      state: backendStates[state],
      stage: 'melody',
      stageProgress: progress / 100,
      overallProgress: progress / 100,
    },
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
  Object.assign(window, {
    desktop: {
      onBackendEvent: (listener: (value: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const stop of stops.splice(0)) stop();
  expect(listeners.size).toBe(0);
  Reflect.deleteProperty(window, 'desktop');
  vi.useRealTimers();
});

const ready = async (initial: Jobs) => {
  let snapshot: Jobs | undefined;
  const requests: PendingRead[] = [];
  const read = vi.fn(
    (ids?: readonly string[], signal?: AbortSignal) =>
      new Promise<Jobs>((resolve, reject) =>
        requests.push({ ids, signal, resolve, reject }),
      ),
  );
  const reader = createJobSnapshotReader(read, () => snapshot);
  stops.push(onJobChange(reader.changed));
  const refresh = (fromEvent = true, controller = new AbortController()) => {
    controllers.push(controller);
    return reader.read(controller.signal, fromEvent).then((value) => {
      snapshot = value;
      return value;
    });
  };
  const first = refresh(false);
  expect(requests[0]?.ids).toBeUndefined();
  requests[0]!.resolve(initial);
  await first;
  requests.length = 0;
  read.mockClear();
  return { requests, read, refresh, current: () => snapshot };
};
const flush = () => vi.advanceTimersByTimeAsync(0);

it('keeps another same-state job pending when it changes during a selective read', async () => {
  const history = job('history', 100, 'completed');
  const source = [job('a'), job('b'), history];
  const reader = await ready(source);
  changed('a', 10);
  const first = reader.refresh();
  expect(reader.requests[0]?.ids).toEqual(['a']);
  changed('b', 20);
  reader.requests[0]!.resolve([job('a', 10)]);
  expect(await first).toEqual([job('a', 10), source[1], history]);
  const trailing = reader.refresh();
  expect(reader.requests[1]?.ids).toEqual(['b']);
  reader.requests[1]!.resolve([job('b', 20)]);
  expect(await trailing).toEqual([job('a', 10), job('b', 20), history]);
  expect(reader.current()?.[2]).toBe(history);
});

it('keeps a newer event for the same job pending after accepting its earlier state snapshot', async () => {
  const history = job('history', 100, 'completed');
  const reader = await ready([job('a'), history]);
  changed('a', 10);
  const first = reader.refresh();
  expect(reader.requests[0]?.ids).toEqual(['a']);
  changed('a', 20);
  reader.requests[0]!.resolve([job('a', 10)]);
  expect(await first).toEqual([job('a', 10), history]);

  const trailing = reader.refresh();
  expect(reader.requests[1]?.ids).toEqual(['a']);
  reader.requests[1]!.resolve([job('a', 20)]);
  expect(await trailing).toEqual([job('a', 20), history]);
  expect(reader.current()?.[1]).toBe(history);
});

it('uses the full authoritative order when an event names a previously unknown job', async () => {
  const existing = job('a', 10);
  const history = job('history', 100, 'completed');
  const reader = await ready([existing, history]);
  changed('inserted', 0, 'queued');
  const pending = reader.refresh();
  expect(reader.requests[0]?.ids).toBeUndefined();
  const reconciled = [job('inserted', 0, 'queued'), existing, history];
  reader.requests[0]!.resolve(reconciled);
  expect(await pending).toBe(reconciled);

  changed('inserted', 20);
  const next = reader.refresh();
  expect(reader.requests[1]?.ids).toEqual(['inserted']);
  reader.requests[1]!.resolve([job('inserted', 20)]);
  expect(await next).toEqual([job('inserted', 20), existing, history]);
});

it('keeps the union of changed IDs across the stale-state barrier retry', async () => {
  const source = [job('a'), job('b', 0, 'queued')];
  const reader = await ready(source);
  changed('a', 10);
  const pending = reader.refresh();
  expect(reader.requests[0]?.ids).toEqual(['a']);
  changed('b', 20);
  reader.requests[0]!.resolve([job('a', 10)]);
  await flush();
  expect(reader.current()).toBe(source);
  expect(reader.requests[1]?.ids).toEqual(['a', 'b']);
  reader.requests[1]!.resolve([job('b', 20), job('a', 15)]);
  expect(await pending).toEqual([job('a', 15), job('b', 20)]);
});

it('keeps full reads across a terminal barrier so a previously missed job is retained', async () => {
  const source = [job('a'), job('history', 100, 'completed')];
  const reader = await ready(source);
  push({ type: 'resync' });
  const pending = reader.refresh();
  expect(reader.requests[0]?.ids).toBeUndefined();
  changed('a', 100, 'completed');
  const complete = [job('b', 5), job('a', 100, 'completed'), source[1]!];
  reader.requests[0]!.resolve(complete);
  await flush();
  expect(reader.current()).toBe(source);
  expect(reader.requests).toHaveLength(2);
  expect(reader.requests[1]?.ids).toBeUndefined();
  reader.requests[1]!.resolve(complete);
  expect(await pending).toEqual(complete);
});

it('does not acknowledge a second resync with the full read started before it', async () => {
  const source = [job('a')];
  const reader = await ready(source);
  push({ type: 'resync' });
  const pending = reader.refresh();
  push({ type: 'resync' });
  reader.requests[0]!.resolve([job('a', 10)]);
  await flush();
  expect(reader.current()).toBe(source);
  expect(reader.requests).toHaveLength(2);
  expect(reader.requests[1]?.ids).toBeUndefined();
  const reconciled = [job('b'), job('a', 20)];
  reader.requests[1]!.resolve(reconciled);
  expect(await pending).toEqual(reconciled);
  changed('a', 25);
  const next = reader.refresh();
  expect(reader.requests[2]?.ids).toEqual(['a']);
  reader.requests[2]!.resolve([job('a', 25)]);
  await next;
});

it('retains full invalidation after a failed reconciliation and another known-ID event', async () => {
  const source = [job('a')];
  const reader = await ready(source);
  push({ type: 'connected' });
  const pending = reader.refresh();
  const failed = expect(pending).rejects.toThrow('Unavailable');
  push({ type: 'resync' });
  changed('a', 10);
  reader.requests[0]!.reject(new Error('Unavailable'));
  await failed;
  expect(reader.current()).toBe(source);
  changed('a', 20);
  const retry = reader.refresh();
  expect(reader.requests[1]?.ids).toBeUndefined();
  const reconciled = [job('b'), job('a', 20)];
  reader.requests[1]!.resolve(reconciled);
  expect(await retry).toEqual(reconciled);
});

it('does not start a full fallback after a cancelled selective read reports 404', async () => {
  const source = [job('a')];
  const reader = await ready(source);
  changed('a', 10);
  const controller = new AbortController();
  const pending = reader.refresh(true, controller);
  const cancelled = expect(pending).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(reader.requests[0]?.ids).toEqual(['a']);
  expect(reader.requests[0]?.signal).toBe(controller.signal);
  controller.abort();
  reader.requests[0]!.reject(
    Object.assign(new Error('Missing'), { code: 'JobNotFound' }),
  );
  await cancelled;
  expect(reader.requests).toHaveLength(1);
  expect(reader.current()).toBe(source);
  expect(listeners.size).toBe(1);
});

it.each([
  ['missing', [job('a', 10)]],
  ['duplicate', [job('a', 10), job('a', 20)]],
  ['unexpected', [job('a', 10), job('other', 20)]],
  ['extra', [job('a', 10), job('b', 20), job('other', 30)]],
] as const)(
  'falls back to a full read for %s selective results without publishing a partial batch',
  async (_kind, updates) => {
    const source = [job('a'), job('b')];
    const reader = await ready(source);
    changed('a', 10);
    changed('b', 20);
    const pending = reader.refresh();
    expect(reader.requests[0]?.ids).toEqual(['a', 'b']);
    reader.requests[0]!.resolve(updates);
    await flush();
    expect(reader.current()).toBe(source);
    expect(reader.requests).toHaveLength(2);
    expect(reader.requests[1]?.ids).toBeUndefined();
    const reconciled = [job('b', 20), job('a', 10)];
    reader.requests[1]!.resolve(reconciled);
    expect(await pending).toEqual(reconciled);
  },
);

it.each(['JobNotFound', 'InvalidJobSnapshot'])(
  'reconciles a selective %s response through the full list',
  async (code) => {
    const reader = await ready([job('a')]);
    changed('a', 10);
    const pending = reader.refresh();
    reader.requests[0]!.reject(Object.assign(new Error(code), { code }));
    await flush();
    expect(reader.requests[1]?.ids).toBeUndefined();
    const reconciled = [job('b', 20)];
    reader.requests[1]!.resolve(reconciled);
    expect(await pending).toEqual(reconciled);
  },
);

it('reconciles hidden insertions and deletions after 30 seconds despite continuous known-ID events', async () => {
  const source = [job('a'), job('deleted', 100, 'completed')];
  const reader = await ready(source);
  const started = Date.now();
  for (let tick = 1; tick <= 120; tick++) {
    vi.setSystemTime(started + tick * 250);
    changed('a', tick / 2);
    const pending = reader.refresh();
    const request = reader.requests.at(-1)!;
    if (tick < 120) {
      expect(request.ids).toEqual(['a']);
      request.resolve([job('a', tick / 2)]);
    } else {
      expect(request.ids).toBeUndefined();
      request.resolve([job('inserted'), job('a', 60)]);
    }
    await pending;
  }
  expect(reader.current()).toEqual([job('inserted'), job('a', 60)]);
  expect(reader.requests.filter(({ ids }) => ids === undefined)).toHaveLength(
    1,
  );
});

it.each(['failed', 'cancelled'])(
  'retains IDs observed before and during a %s selective read',
  async (outcome) => {
    const source = [job('a'), job('b')];
    const reader = await ready(source);
    changed('a', 10);
    const controller = new AbortController();
    const pending = reader.refresh(true, controller);
    const rejected = expect(pending).rejects.toMatchObject({
      name: outcome === 'cancelled' ? 'AbortError' : 'Error',
    });
    changed('b', 20);
    if (outcome === 'cancelled') {
      controller.abort();
      reader.requests[0]!.resolve([job('a', 10)]);
    } else reader.requests[0]!.reject(new Error('Unavailable'));
    await rejected;
    expect(reader.current()).toBe(source);
    const retry = reader.refresh();
    expect(reader.requests[1]?.ids).toEqual(['a', 'b']);
    reader.requests[1]!.resolve([job('a', 10), job('b', 20)]);
    expect(await retry).toEqual([job('a', 10), job('b', 20)]);
  },
);

it('does not let an older cancelled full read acknowledge or invalidate the newer accepted generation', async () => {
  const reader = await ready([job('a')]);
  push({ type: 'resync' });
  const oldController = new AbortController();
  const old = reader.refresh(true, oldController);
  const cancelled = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  oldController.abort();
  push({ type: 'resync' });
  changed('a', 20);
  const current = reader.refresh();
  expect(reader.requests[1]?.ids).toBeUndefined();
  const reconciled = [job('b'), job('a', 20)];
  reader.requests[1]!.resolve(reconciled);
  expect(await current).toEqual(reconciled);
  changed('b', 30);
  reader.requests[0]!.resolve([job('a', 5)]);
  await cancelled;
  expect(reader.current()).toEqual(reconciled);
  const next = reader.refresh();
  expect(reader.requests[2]?.ids).toEqual(['b']);
  reader.requests[2]!.resolve([job('b', 30)]);
  expect(await next).toEqual([job('b', 30), job('a', 20)]);
});

it('uses a full snapshot for an explicit refresh even with known IDs pending', async () => {
  const reader = await ready([job('a')]);
  changed('a', 10);
  const pending = reader.refresh(false);
  expect(reader.requests[0]?.ids).toBeUndefined();
  const reconciled = [job('new'), job('a', 10)];
  reader.requests[0]!.resolve(reconciled);
  expect(await pending).toEqual(reconciled);
});
