import { act, render, screen, waitFor, within } from '@testing-library/react';
import { runInAction } from 'mobx';
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ParticipantDto, RoomStateDto } from '../../contracts/models';
import type { OnlineInbox, SocialPerson } from '../../contracts/social';
import { store } from '../../providers/store';
import { RoomDock } from './RoomDock';
import type { RoomHeadCard } from './RoomHeadCard';
import type { RoomPersonCard } from './RoomPersonCard';

const ports = vi.hoisted(() => ({
  people: vi.fn(),
  membership: { copyInvite: vi.fn() },
  runtime: { getProject: () => undefined },
  notify: vi.fn(),
}));

vi.mock('@neo-ui-kit/react', () => ({
  tr: (key: string) => key,
  setLocale: vi.fn(),
  useLocale: () => 'en',
  useRouter: () => ({ pathname: '/' }),
  Button: ({ children, onClick }: { children: ReactNode; onClick(): void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock('../../providers/application', () => ({
  getRoomRuntime: () => ports.runtime,
  useRoomMembership: () => ports.membership,
  useRoomLibraryCommands: () => null,
  roomSession: { leave: vi.fn(), close: vi.fn() },
}));
vi.mock('../../providers/dialog', () => ({ ask: vi.fn() }));
vi.mock('../../providers/notifications', () => ({
  useNotify: () => ports.notify,
}));
vi.mock('../../services/socialClient', () => ({
  socialClient: { people: ports.people },
}));
vi.mock('../../shared/ui/DetachedPanel', () => ({
  DetachedPanel: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../../shared/ui/useDetachedPanel', () => ({
  useDetachedPanel: () => ({
    detached: false,
    heldPointer: { current: null },
    resumeDrag: vi.fn(),
  }),
}));
vi.mock('../../shared/ui/useFloatingPanel', () => ({
  controlSelector: 'button',
  useStoredPanelLayout: () => ({ layout: null, save: vi.fn() }),
  useMeasuredPanelSize: () => ({ width: 555, height: 660 }),
  useFloatingPanel: () => ({ layout: null }),
}));
vi.mock('../playlists/PlaylistDialog', () => ({ PlaylistDialog: () => null }));
vi.mock('./RoomLinkCard', () => ({ RoomLinkCard: () => null }));
vi.mock('./RoomHeadCard', () => ({
  RoomHeadCard: ({ room, actions }: ComponentProps<typeof RoomHeadCard>) => (
    <div aria-label="room status">
      {room.connectionStatus} {room.songId} {room.transferProgress}
      <button onClick={actions.onPlaylists}>
        {room.playlist
          ? `${room.playlist.name} · ${room.playlist.index + 1}/${room.playlist.songs.length}`
          : 'playlists'}
      </button>
    </div>
  ),
}));
vi.mock('./RoomPersonCard', () => ({
  RoomPersonCard: ({
    participant,
    person,
    hostControls,
  }: ComponentProps<typeof RoomPersonCard>) => (
    <li aria-label={participant.name}>
      {participant.name} {person?.relation}
      {hostControls && !participant.self && <button>transferHost</button>}
    </li>
  ),
}));

const participant = (id: string, name: string): ParticipantDto => ({
  id,
  name,
  role: id === 'self' ? 'host' : 'participant',
  self: id === 'self',
  connected: true,
  muted: false,
  volume: 1,
  readiness: 'ready',
});
const room: RoomStateDto = {
  code: 'room',
  hostId: 'self',
  role: 'host',
  participants: [participant('self', 'Singer')],
  playbackLocked: false,
  connectionStatus: 'connected',
};
const friend: SocialPerson = {
  accountId: 'friend-account',
  displayName: 'Friend',
  avatarVersion: 0,
  presence: 'InRoom',
  roomId: room.code,
  lastSeenAt: null,
  relation: 'None',
};
const inbox: OnlineInbox = {
  type: 'inbox',
  me: {
    accountId: 'self-account',
    displayName: 'Singer',
    friendCode: 'my-code',
    transferCode: 'transfer-code',
    avatarVersion: 0,
  },
  friends: [],
  friendRequests: [],
  outgoingRequests: [],
  invites: [],
  notices: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  ports.people.mockResolvedValue([]);
  runInAction(() => {
    store.online.room = room;
    store.setInbox({ type: 'offline' });
  });
});

it('updates the visible room and host actions when a snapshot changes within the same session', async () => {
  render(<RoomDock />);
  await act(async () => undefined);
  expect(
    screen.getByRole('list', { name: 'participants' }).children,
  ).toHaveLength(1);

  act(() => {
    runInAction(() => {
      store.online.room = {
        ...room,
        hostId: 'friend',
        role: 'participant',
        participants: [
          { ...participant('self', 'Singer'), role: 'participant' },
          { ...participant('friend', 'Friend'), role: 'host' },
        ],
        songId: 'new-song',
        transferProgress: 45,
        connectionStatus: 'reconnecting',
        playlist: {
          name: 'Party',
          songs: [{ songId: 'new-song', revision: 1 }],
          index: 0,
        },
      };
    });
  });

  expect(screen.getByRole('listitem', { name: 'Friend' })).toBeVisible();
  expect(screen.getByLabelText('room status')).toHaveTextContent(
    'reconnecting new-song 45',
  );
  expect(screen.getByRole('button', { name: 'Party · 1/1' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'transferHost' })).toBeNull();
});

it('updates a participant friendship after the pushed inbox changes without a room snapshot', async () => {
  ports.people.mockResolvedValue([{ participantId: 'friend', person: friend }]);
  runInAction(() => {
    store.online.room = {
      ...room,
      participants: [participant('friend', 'Friend')],
    };
    store.setInbox(inbox);
  });
  render(<RoomDock />);
  const person = screen.getByRole('listitem', { name: 'Friend' });
  await waitFor(() => expect(person).toHaveTextContent('None'));
  expect(
    within(person).getByRole('button', { name: 'transferHost' }),
  ).toBeVisible();

  act(() =>
    store.setInbox({ ...inbox, friends: [{ ...friend, relation: 'Friend' }] }),
  );

  expect(person).toHaveTextContent('Friend Friend');
  expect(ports.people).toHaveBeenCalledTimes(1);
});
