import { expect, it, vi } from 'vitest';
import { RoomInvitationCoordinator } from './RoomInvitationCoordinator';

it('accepts an invitation through the room session and clears the pending request only after join', async () => {
  const events: string[] = [];
  const social = {
    acceptInvite: vi.fn(async () => ({ roomId: 'B' })),
    clearRequestedRoom: vi.fn(() => {
      events.push('clear');
    }),
  };
  const room = {
    getRoom: () => ({ code: 'A' }),
    leave: vi.fn(async () => {
      events.push('leave');
    }),
    join: vi.fn(async () => {
      events.push('join');
      return { code: 'B' };
    }),
  };
  const invitations = new RoomInvitationCoordinator(
    social as never,
    room as never,
  );
  await invitations.accept('invite', 'Singer');
  expect(events).toEqual(['leave', 'join', 'clear']);
});

it.each(['leave', 'join'])(
  'retries a failed %s without accepting the invitation twice',
  async (failedStep) => {
    const social = {
      acceptInvite: vi
        .fn()
        .mockResolvedValueOnce({ roomId: 'B' })
        .mockRejectedValue(new Error('InviteAnswered')),
      clearRequestedRoom: vi.fn(),
    };
    const room = {
      getRoom: () => (failedStep === 'leave' ? { code: 'A' } : null),
      leave: vi.fn().mockResolvedValue(undefined),
      join: vi.fn().mockResolvedValue({ code: 'B' }),
    };
    room[failedStep as 'leave' | 'join'].mockRejectedValueOnce(
      new Error('AudioService unavailable'),
    );
    const invitations = new RoomInvitationCoordinator(
      social as never,
      room as never,
    );
    await expect(invitations.accept('invite', 'Singer')).rejects.toThrow(
      'AudioService unavailable',
    );
    expect(social.clearRequestedRoom).not.toHaveBeenCalled();
    invitations.prune([]);
    expect(invitations.isHandled('invite')).toBe(false);
    await invitations.accept('invite', 'Singer');
    expect(social.acceptInvite).toHaveBeenCalledOnce();
    expect(social.clearRequestedRoom).toHaveBeenCalledWith('B');
  },
);

it('deduplicates an in-flight join after the server removes its accepted invitation', async () => {
  let finish!: (value: { code: string }) => void;
  const social = {
    acceptInvite: vi.fn(async () => ({ roomId: 'B' })),
    clearRequestedRoom: vi.fn(),
  };
  const room = {
    getRoom: () => null,
    leave: vi.fn(),
    join: vi.fn(
      () =>
        new Promise<{ code: string }>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const invitations = new RoomInvitationCoordinator(
    social as never,
    room as never,
  );
  const first = invitations.accept('invite', 'Singer');
  await vi.waitFor(() => expect(room.join).toHaveBeenCalledOnce());
  invitations.prune([]);
  const second = invitations.accept('invite', 'Singer');
  expect(second).toBe(first);
  finish({ code: 'B' });
  await first;
  expect(social.acceptInvite).toHaveBeenCalledOnce();
});

it('retries server acceptance when the invitation has not been accepted yet', async () => {
  const social = {
    acceptInvite: vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce({ roomId: 'B' }),
    clearRequestedRoom: vi.fn(),
  };
  const room = {
    getRoom: () => null,
    leave: vi.fn(),
    join: vi.fn().mockResolvedValue({ code: 'B' }),
  };
  const invitations = new RoomInvitationCoordinator(
    social as never,
    room as never,
  );
  await expect(invitations.accept('invite', 'Singer')).rejects.toThrow(
    'Offline',
  );
  expect(room.join).not.toHaveBeenCalled();
  expect(invitations.isHandled('invite')).toBe(false);
  expect(invitations.canRetry('invite')).toBe(false);
  await invitations.accept('invite', 'Singer');
  expect(social.acceptInvite).toHaveBeenCalledTimes(2);
  expect(room.join).toHaveBeenCalledOnce();
});

it('does not join twice while an accepted invitation remains in the inbox', async () => {
  const social = {
    acceptInvite: vi.fn(async () => ({ roomId: 'B' })),
    clearRequestedRoom: vi.fn(),
  };
  const room = {
    getRoom: () => null,
    leave: vi.fn(),
    join: vi.fn(async () => ({ code: 'B' })),
  };
  const invitations = new RoomInvitationCoordinator(
    social as never,
    room as never,
  );
  await invitations.accept('invite', 'Singer');
  await invitations.accept('invite', 'Singer');
  expect(room.join).toHaveBeenCalledOnce();
  expect(invitations.isHandled('invite')).toBe(true);
  invitations.prune([]);
  expect(invitations.isHandled('invite')).toBe(false);
});

it('serializes two different accepted invitations so the second cannot inherit the first join', async () => {
  let finishFirst!: (value: { code: string }) => void;
  let current: { code: string } | null = null;
  const events: string[] = [];
  const social = {
    acceptInvite: vi.fn(async (id: string) => ({ roomId: id })),
    clearRequestedRoom: vi.fn(),
  };
  const room = {
    getRoom: () => current,
    leave: vi.fn(async () => {
      events.push('leave');
      current = null;
    }),
    join: vi.fn((_: string, code: string) => {
      events.push(`join:${code}`);
      if (code === 'A')
        return new Promise<{ code: string }>((resolve) => {
          finishFirst = resolve;
        }).then((joined) => {
          current = joined;
          return joined;
        });
      current = { code };
      return Promise.resolve(current);
    }),
  };
  const invitations = new RoomInvitationCoordinator(
    social as never,
    room as never,
  );
  const first = invitations.accept('A', 'Singer');
  const second = invitations.accept('B', 'Singer');
  await vi.waitFor(() => expect(room.join).toHaveBeenCalled());
  expect(events).toEqual(['join:A']);
  finishFirst({ code: 'A' });
  await Promise.all([first, second]);
  expect(events).toEqual(['join:A', 'leave', 'join:B']);
  expect(room.getRoom()).toEqual({ code: 'B' });
});
