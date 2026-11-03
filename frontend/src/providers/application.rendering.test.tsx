import { readText, removeKey, storageKey } from '../shared/storage/localStore';
import { observer } from 'mobx-react-lite';
import { store } from './store';
import { QueryProvider } from '../test/QueryProvider';
import { act, render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { roomSession } from './application';
import type { ProcessingJobDto } from '../contracts/models';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { subscribeApplication } from './application';

const jobs = vi.hoisted(() => ({
  list: vi.fn<() => Promise<ProcessingJobDto[]>>(async () => []),
  refresh: () => {},
}));
vi.mock('../services/pythonClient', () => ({
  pythonClient: { listJobs: jobs.list },
}));
vi.mock('../services/backendEvents', async (original) => ({
  ...(await original<typeof import('../services/backendEvents')>()),
  refreshOnJobChanges: (refresh: () => void) => {
    jobs.refresh = refresh;
    return () => {};
  },
}));
beforeEach(() => jobs.list.mockResolvedValue([]));

const roomPorts = vi.hoisted(() => ({
  createRoom: vi.fn(async () => ({
    code: 'joined',
    hostId: 'host',
    role: 'host',
    participants: [],
    playbackLocked: false,
  })),
  joinVoiceSession: vi.fn(async () => undefined),
  setRoomPlayoutDelay: vi.fn(async () => undefined),
}));
vi.mock('../services/audioClient', () => ({
  audioClient: {
    joinVoiceSession: roomPorts.joinVoiceSession,
    setRoomPlayoutDelay: roomPorts.setRoomPlayoutDelay,
  },
}));
vi.mock('../services/roomClient', () => ({
  roomClient: {
    createRoom: roomPorts.createRoom,
  },
}));
vi.mock('../services/desktopClient', () => ({
  desktopClient: { setAppIcon: vi.fn() },
}));
vi.mock('../shared/preferences/appFonts', async (original) => ({
  ...(await original<typeof import('../shared/preferences/appFonts')>()),
  applyAppFonts: vi.fn(),
}));

it('subscribes React room views to the application session owner', async () => {
  let session!: typeof roomSession;
  let visibleRoom: string | null = null;
  const Commands = () => {
    session = roomSession;
    return null;
  };
  const Room = observer(() => {
    visibleRoom = store.online.room?.code ?? null;
    return null;
  });
  const view = render(
    <QueryProvider application>
      <Commands />
      <Room />
    </QueryProvider>,
  );

  await act(async () => {
    await session.join('Singer');
  });

  expect(visibleRoom).toBe('joined');
  expect(roomPorts.joinVoiceSession).toHaveBeenCalledOnce();
  view.unmount();
});

it('does not expose room snapshot mutation through presentation actions', () => {
  let actions!: typeof store;
  const Capture = () => {
    actions = store;
    return null;
  };
  const view = render(
    <QueryProvider application>
      <Capture />
    </QueryProvider>,
  );
  expect(actions).not.toHaveProperty('setRoom');
  view.unmount();
});

it('disposes the connection without erasing the persisted room for the next mount', async () => {
  const view = render(<QueryProvider application>{null}</QueryProvider>);
  const previous = roomSession;
  await act(async () => {
    await previous.join('Singer');
  });
  const key = storageKey('roomSession');
  expect(readText(key)).toBe('joined');
  view.unmount();
  expect(roomSession).not.toBe(previous);
  expect(store.online.room).toBeNull();
  expect(readText(key)).toBe('joined');
  removeKey(key);
});

it('refreshes active model caches after events and reconnection without a polling tick', async () => {
  const listeners = new Set<(event: unknown) => void>();
  Object.assign(window, { desktop: { onBackendEvent: (listener: (event: unknown) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let generation = 1;
  const read = vi.fn(async () => generation);
  const observers = [
    ['models', 'required'], ['model-free-space'],
    ['job', 'ModelDownload', 'model:1'], ['job', 'ModelDownload', 'other:1'],
  ].map((queryKey) =>
    new QueryObserver(client, { queryKey, queryFn: read }),
  );
  const stops = observers.map((observer) => observer.subscribe(() => undefined));
  const stop = subscribeApplication(client);
  try {
    await vi.waitFor(() => expect(client.getQueryData(['models', 'required'])).toBe(1));
    for (const type of ['models.changed', 'connected', 'resync']) {
      generation += 1;
      listeners.forEach((listener) => listener({ type }));
      await vi.waitFor(() => {
        expect(client.getQueryData(['models', 'required'])).toBe(generation);
        expect(client.getQueryData(['model-free-space'])).toBe(generation);
      });
    }
    expect(read).toHaveBeenCalledTimes(14);
    generation += 1;
    listeners.forEach((listener) => listener({
      type: 'job.changed', data: { jobId: 'j1', type: 'ModelDownload', entityId: 'model:1' },
    }));
    await vi.waitFor(() => expect(client.getQueryData(['job', 'ModelDownload', 'model:1'])).toBe(5));
    expect(client.getQueryData(['job', 'ModelDownload', 'other:1'])).toBe(4);
    expect(read).toHaveBeenCalledTimes(15);
  } finally {
    stop();
    stops.forEach((unsubscribe) => unsubscribe());
    observers.forEach((observer) => observer.destroy());
    client.clear();
    Reflect.deleteProperty(window, 'desktop');
  }
  expect(listeners.size).toBe(0);
});
