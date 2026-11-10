import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  backendPollInterval,
  nextJobChange,
  nextRecordingChange,
  onLibraryChange,
  onJobChange,
  onModelsChange,
  onRecordingsChange,
  readBackendSnapshot,
  refreshOnJobChanges,
} from './backendEvents';

let listeners: ((event: unknown) => void)[] = [];
const push = (event: unknown) =>
  [...listeners].forEach((listener) => listener(event));
const jobChanged = (jobId: string) =>
  push({ type: 'job.changed', data: { jobId } });

beforeEach(() => {
  vi.useFakeTimers();
  listeners = [];
  Object.assign(window, {
    desktop: {
      onBackendEvent: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => {
          listeners = listeners.filter((item) => item !== listener);
        };
      },
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'desktop');
});

it("wakes a job wait on that job's change or a reconnection, not on another job", async () => {
  const resolved = vi.fn();
  void nextJobChange('j1', 250).then(resolved);
  jobChanged('other');
  await vi.advanceTimersByTimeAsync(1000);
  expect(resolved).not.toHaveBeenCalled();
  jobChanged('j1');
  await vi.advanceTimersByTimeAsync(0);
  expect(resolved).toHaveBeenCalled();
  expect(listeners).toHaveLength(0);

  const afterReconnect = vi.fn();
  void nextJobChange('j1', 250).then(afterReconnect);
  push({ type: 'connected' });
  await vi.advanceTimersByTimeAsync(0);
  expect(afterReconnect).toHaveBeenCalled();
});

it('still checks a job now and then when its change never arrives', async () => {
  const resolved = vi.fn();
  void nextJobChange('j1', 250).then(resolved);
  await vi.advanceTimersByTimeAsync(4999);
  expect(resolved).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(resolved).toHaveBeenCalled();
});

it('polls at the given interval when nothing can be pushed', async () => {
  Reflect.deleteProperty(window, 'desktop');
  const resolved = vi.fn();
  void nextJobChange('j1', 250).then(resolved);
  await vi.advanceTimersByTimeAsync(250);
  expect(resolved).toHaveBeenCalled();
});

it('refreshes after a burst of job changes at most once per interval and stops when unsubscribed', async () => {
  const refresh = vi.fn();
  const unsubscribe = refreshOnJobChanges(refresh, 1000);
  jobChanged('a');
  jobChanged('b');
  jobChanged('a');
  await vi.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(1);
  jobChanged('a');
  await vi.advanceTimersByTimeAsync(999);
  expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  unsubscribe();
  jobChanged('a');
  await vi.advanceTimersByTimeAsync(5000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('refreshes the library after a committed change and after missed events, then unsubscribes', () => {
  const refresh = vi.fn();
  const stop = onLibraryChange(refresh);
  push({ type: 'library.changed', data: { songIds: ['song'] } });
  expect(refresh).toHaveBeenCalledTimes(1);
  push({ type: 'resync' });
  expect(refresh).toHaveBeenCalledTimes(2);
  stop();
  push({ type: 'library.changed', data: { deletedIds: ['song'] } });
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('rechecks a waiting job when the event stream reports dropped messages', async () => {
  const resolved = vi.fn();
  void nextJobChange('j1', 250).then(resolved);
  push({ type: 'resync' });
  await vi.advanceTimersByTimeAsync(0);
  expect(resolved).toHaveBeenCalledOnce();
  expect(listeners).toHaveLength(0);
});

it('uses events for models and recordings and reloads both after reconnection or overflow', () => {
  const models = vi.fn();
  const recordings = vi.fn();
  const stops = [onModelsChange(models), onRecordingsChange(recordings)];
  push({ type: 'models.changed' });
  expect(models).toHaveBeenCalledOnce();
  expect(recordings).not.toHaveBeenCalled();
  push({ type: 'recordings.changed' });
  push({ type: 'connected' });
  push({ type: 'resync' });
  expect(models).toHaveBeenCalledTimes(3);
  expect(recordings).toHaveBeenCalledTimes(3);
  stops.forEach((stop) => stop());
  expect(listeners).toHaveLength(0);
});

it('keeps a slow safety reconciliation and the original polling without a desktop bridge', () => {
  expect(backendPollInterval(1000)).toBe(30_000);
  Reflect.deleteProperty(window, 'desktop');
  expect(backendPollInterval(1000)).toBe(1000);
  expect(backendPollInterval(false)).toBe(false);
});

it('keeps the changed job identity so unrelated query caches do not need refreshing', () => {
  const changed = vi.fn();
  const stop = onJobChange(changed);
  push({
    type: 'job.changed',
    data: { jobId: 'j1', type: 'ModelDownload', entityId: 'model:1' },
  });
  expect(changed).toHaveBeenCalledWith('j1', {
    jobId: 'j1',
    type: 'ModelDownload',
    entityId: 'model:1',
  });
  stop();
});

it('wakes recording preparation on an event and still rechecks if that event is missed', async () => {
  const event = vi.fn();
  void nextRecordingChange(750).then(event);
  push({ type: 'recordings.changed' });
  await vi.advanceTimersByTimeAsync(0);
  expect(event).toHaveBeenCalledOnce();
  const safety = vi.fn();
  void nextRecordingChange(750).then(safety);
  await vi.advanceTimersByTimeAsync(5000);
  expect(safety).toHaveBeenCalledOnce();
  expect(listeners).toHaveLength(0);
});

it('unsubscribes an aborted snapshot read and does not retry its stale response', async () => {
  const controller = new AbortController();
  let finish!: (value: string) => void;
  const read = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = readBackendSnapshot(
    read,
    ['models.changed'],
    controller.signal,
  );
  const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  push({ type: 'models.changed' });
  controller.abort();
  finish('old');
  await result;
  expect(read).toHaveBeenCalledOnce();
  expect(listeners).toHaveLength(0);
});
