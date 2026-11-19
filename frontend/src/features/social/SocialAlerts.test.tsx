import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { OnlineInbox } from '../../contracts/social';
import { RoomInvitationCoordinator } from '../../application/social/RoomInvitationCoordinator';
import { SocialAlerts } from './SocialAlerts';

const social = vi.hoisted(() => ({
  coordinator: null as RoomInvitationCoordinator | null,
  friends: { accept: vi.fn() },
  invitations: {
    subscribe: () => () => undefined,
    getSnapshot: () => 0,
    availableInvites: (invites: OnlineInbox['invites']) => invites,
    prune: vi.fn(),
    isRequestedRoom: vi.fn(() => true),
    isHandled: vi.fn(() => false),
    canRetry: vi.fn(() => false),
    accept: vi.fn(),
  },
  notify: vi.fn(),
}));
vi.mock('@neo-ui-kit/react', () => ({
  tr: (key: string) => key,
  useLocale: () => 'en',
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled: boolean;
    onClick(): void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../providers/social', () => ({
  friendRelations: social.friends,
  useRoomInvitations: () => social.coordinator ?? social.invitations,
}));
vi.mock('../../providers/store', () => ({
  store: { preferences: { displayName: 'Singer' }, online: { room: null } },
}));
vi.mock('../../providers/notifications', () => ({
  useNotify: () => social.notify,
  playNotificationSound: vi.fn(),
}));
vi.mock('./PersonAvatar', () => ({ PersonAvatar: () => null }));

const person = { accountId: 'friend', displayName: 'Friend' };
const inbox = {
  type: 'inbox',
  me: { displayName: 'Singer' },
  friendRequests: [],
  invites: [],
  notices: [],
} as unknown as OnlineInbox;
const approved = { inviteId: 'approval', roomId: 'ROOM', sender: person };
beforeEach(() => {
  vi.clearAllMocks();
  social.coordinator = null;
  social.invitations.accept.mockResolvedValue(undefined);
});

it('accepts an approved join after the current friends action finishes', async () => {
  let finish!: () => void;
  social.friends.accept.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <SocialAlerts
      inbox={{ ...inbox, friendRequests: [person] } as OnlineInbox}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'social.acceptAction' }));
  view.rerender(
    <SocialAlerts inbox={{ ...inbox, invites: [approved] } as OnlineInbox} />,
  );
  expect(social.invitations.accept).not.toHaveBeenCalled();
  await act(async () => {
    finish();
  });
  await waitFor(() =>
    expect(social.invitations.accept).toHaveBeenCalledTimes(1),
  );
  expect(social.invitations.accept).toHaveBeenCalledWith(approved, 'Singer');
});

it('offers a manual retry when accepting an approved join fails', async () => {
  social.invitations.accept.mockRejectedValueOnce(new Error('Offline'));
  render(
    <SocialAlerts inbox={{ ...inbox, invites: [approved] } as OnlineInbox} />,
  );
  const retry = await screen.findByRole('button', {
    name: 'social.acceptAction',
  });
  await waitFor(() => expect(retry).not.toBeDisabled());
  expect(social.invitations.accept).toHaveBeenCalledTimes(1);
  fireEvent.click(retry);
  await waitFor(() =>
    expect(social.invitations.accept).toHaveBeenCalledTimes(2),
  );
});

it.each([false, true])(
  'keeps an accepted invitation retryable after its inbox entry disappears (requested: %s)',
  async (requested) => {
    let failJoin!: (error: Error) => void;
    const port = {
      acceptInvite: vi
        .fn()
        .mockResolvedValueOnce({ roomId: 'ROOM' })
        .mockRejectedValue(new Error('InviteAnswered')),
      isRequestedRoom: () => requested,
      clearRequestedRoom: vi.fn(),
    };
    const room = {
      getRoom: () => null,
      leave: vi.fn(),
      join: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              failJoin = reject;
            }),
        )
        .mockResolvedValue({ code: 'ROOM' }),
    };
    social.coordinator = new RoomInvitationCoordinator(
      port as never,
      room as never,
    );
    const view = render(
      <SocialAlerts inbox={{ ...inbox, invites: [approved] } as OnlineInbox} />,
    );
    if (!requested)
      fireEvent.click(
        screen.getByRole('button', { name: 'social.acceptAction' }),
      );
    await waitFor(() => expect(room.join).toHaveBeenCalledOnce());
    view.rerender(<SocialAlerts inbox={inbox} />);
    await act(async () => {
      failJoin(new Error('AudioService unavailable'));
    });
    const retry = await screen.findByRole('button', {
      name: /^(retry|social\.acceptAction)$/,
    });
    await waitFor(() => expect(retry).not.toBeDisabled());
    expect(room.join).toHaveBeenCalledOnce();
    if (requested) {
      view.rerender(<SocialAlerts inbox={{ type: 'offline' }} />);
      view.rerender(<SocialAlerts inbox={inbox} />);
      expect(room.join).toHaveBeenCalledOnce();
    }
    fireEvent.click(
      screen.getByRole('button', { name: /^(retry|social\.acceptAction)$/ }),
    );
    await waitFor(() => expect(room.join).toHaveBeenCalledTimes(2));
    expect(port.acceptInvite).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', {
          name: /^(retry|social\.acceptAction)$/,
        }),
      ).toBeNull(),
    );
  },
);

it('dismisses a failed accepted invitation locally even while the server inbox is stale', async () => {
  const port = {
    acceptInvite: vi
      .fn()
      .mockResolvedValueOnce({ roomId: 'ROOM' })
      .mockRejectedValue(new Error('InviteAnswered')),
    declineInvite: vi.fn().mockRejectedValue(new Error('InviteAnswered')),
    isRequestedRoom: () => false,
    clearRequestedRoom: vi.fn(),
  };
  const room = {
    getRoom: () => null,
    leave: vi.fn(),
    join: vi.fn().mockRejectedValue(new Error('AudioService unavailable')),
  };
  social.coordinator = new RoomInvitationCoordinator(
    port as never,
    room as never,
  );
  const view = render(
    <SocialAlerts inbox={{ ...inbox, invites: [approved] } as OnlineInbox} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'social.acceptAction' }));
  await waitFor(() => expect(social.notify).toHaveBeenCalledOnce());
  fireEvent.click(
    screen.getByRole('button', { name: /^(close|social\.declineAction)$/ }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: /^(retry|social\.acceptAction)$/ }),
    ).toBeNull(),
  );
  expect(port.declineInvite).not.toHaveBeenCalled();
  expect(port.clearRequestedRoom).toHaveBeenCalledWith('ROOM');
  view.rerender(<SocialAlerts inbox={inbox} />);
  expect(
    screen.queryByRole('button', { name: /^(retry|social\.acceptAction)$/ }),
  ).toBeNull();
});

it('removes an unaccepted invitation when it expires from the server inbox', () => {
  const port = { isRequestedRoom: () => false };
  social.coordinator = new RoomInvitationCoordinator(
    port as never,
    {} as never,
  );
  const view = render(
    <SocialAlerts inbox={{ ...inbox, invites: [approved] } as OnlineInbox} />,
  );
  expect(
    screen.getByRole('button', { name: 'social.acceptAction' }),
  ).toBeEnabled();
  view.rerender(<SocialAlerts inbox={inbox} />);
  expect(
    screen.queryByRole('button', { name: 'social.acceptAction' }),
  ).toBeNull();
});
