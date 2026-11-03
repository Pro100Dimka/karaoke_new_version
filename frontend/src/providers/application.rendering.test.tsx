import { readText, removeKey, storageKey } from '../shared/storage/localStore';
import { observer } from 'mobx-react-lite';
import { store } from './store';
import { QueryProvider } from '../test/QueryProvider';
import { act, render } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { roomSession } from './application';
import type { ProcessingJobDto } from '../contracts/models';

const jobs = vi.hoisted(() => ({
  list: vi.fn<() => Promise<ProcessingJobDto[]>>(async () => []),
  refresh: () => {},
}));
vi.mock('../services/pythonClient', () => ({
  pythonClient: { listJobs: jobs.list },
}));
vi.mock('../services/backendEvents', () => ({
  backendEventsAvailable: () => true,
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
