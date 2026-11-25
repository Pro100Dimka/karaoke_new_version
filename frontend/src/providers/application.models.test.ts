import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { modelsQuery, requiredModelsQuery } from '../components/api-service';
import type { AIModel } from '../utils/contracts';
import { subscribeApplication } from './application';

vi.mock('../services/pythonClient', () => ({
  pythonClient: { listJobs: async () => [] },
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

const model = (state: AIModel['state']): AIModel => ({
  modelId: 'voice',
  version: '1',
  purpose: 'Pitch',
  state,
  size: 100,
  requiredDiskBytes: 200,
});
const listeners = new Set<(event: unknown) => void>();
const changed = () => {
  for (const listener of [...listeners]) listener({ type: 'models.changed' });
};
let client: QueryClient;
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, networkMode: 'always' },
    },
  });
  Object.assign(window, {
    desktop: {
      onBackendEvent: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  client.clear();
  listeners.clear();
  Reflect.deleteProperty(window, 'desktop');
  vi.useRealTimers();
});

it.each([modelsQuery, requiredModelsQuery])(
  'keeps one model transport and one fresh follow-up for $queryKey during an event burst',
  async (options) => {
    const replies: ((state: AIModel['state']) => void)[] = [];
    let active = 0;
    let maximum = 0;
    Object.assign(window.desktop!, {
      pythonRequest: () => {
        maximum = Math.max(maximum, ++active);
        return new Promise((resolve) =>
          replies.push((state) =>
            resolve({ ok: true, status: 200, body: [model(state)] }),
          ),
        ).finally(() => active--);
      },
    });
    client.setQueryData(options.queryKey, [model('Missing')]);
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => undefined);
    stop = subscribeApplication(client);
    try {
      for (let update = 0; update < 100; update++) changed();
      expect(replies).toHaveLength(1);
      replies[0]!('Downloading');
      await vi.advanceTimersByTimeAsync(1);
      expect(replies).toHaveLength(2);
      expect(client.getQueryData(options.queryKey)).toEqual([model('Missing')]);
      replies[1]!('Ready');
      await vi.advanceTimersByTimeAsync(1);
      expect(client.getQueryData(options.queryKey)).toEqual([model('Ready')]);
      expect(replies).toHaveLength(2);
      expect(maximum).toBe(1);
    } finally {
      unsubscribe();
      observer.destroy();
      for (const reply of replies) reply('Ready');
      await vi.advanceTimersByTimeAsync(1);
    }
  },
);

it('coalesces free-space refreshes and follows an outstanding disk read after a model change', async () => {
  const replies: ((value: number) => void)[] = [];
  const queryKey = ['model-free-space'];
  client.setQueryData(queryKey, 10);
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: () => new Promise<number>((resolve) => replies.push(resolve)),
  });
  const unsubscribe = observer.subscribe(() => undefined);
  stop = subscribeApplication(client);
  try {
    for (let update = 0; update < 100; update++) changed();
    expect(replies).toHaveLength(1);
    replies[0]!(20);
    await vi.advanceTimersByTimeAsync(1);
    expect(replies).toHaveLength(2);
    replies[1]!(30);
    await vi.advanceTimersByTimeAsync(1);
    expect(replies).toHaveLength(2);
    expect(client.getQueryData(queryKey)).toBe(30);
  } finally {
    unsubscribe();
    observer.destroy();
    for (const reply of replies) reply(30);
    await vi.advanceTimersByTimeAsync(1);
  }
});

it('does not launch the model follow-up after its view unsubscribes', async () => {
  let reply!: () => void;
  const read = vi.fn(
    () =>
      new Promise((resolve) => {
        reply = () =>
          resolve({ ok: true, status: 200, body: [model('Downloading')] });
      }),
  );
  Object.assign(window.desktop!, { pythonRequest: read });
  client.setQueryData(modelsQuery.queryKey, [model('Missing')]);
  const observer = new QueryObserver(client, modelsQuery);
  const unsubscribe = observer.subscribe(() => undefined);
  stop = subscribeApplication(client);
  changed();
  unsubscribe();
  observer.destroy();
  const before = read.mock.calls.length;
  reply();
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(before);
  expect(client.getQueryData(modelsQuery.queryKey)).toEqual([model('Missing')]);
});
