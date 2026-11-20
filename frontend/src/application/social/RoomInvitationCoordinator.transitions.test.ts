import { expect, it, vi } from 'vitest';
import type { RoomStateDto } from '../../contracts/models';
import { RoomSessionController } from '../room/RoomSessionController';
import { RoomInvitationCoordinator } from './RoomInvitationCoordinator';

const snapshot = (code: string): RoomStateDto => ({
  code,
  hostId: 'self',
  role: 'host',
  participants: [],
  playbackLocked: false,
});

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
};

const setup = () => {
  const transport = {
    createRoom: vi.fn(async () => snapshot('created')),
    joinRoom: vi.fn(async (code: string) => snapshot(code)),
    leaveRoom: vi.fn(async () => undefined),
    closeRoom: vi.fn(async () => undefined),
  };
  const voice = {
    setRoomPlayoutDelay: vi.fn(async () => undefined),
    joinVoiceSession: vi.fn(async () => undefined),
    leaveVoiceSession: vi.fn(async () => undefined),
  };
  const social = {
    acceptInvite: vi.fn(async () => ({ roomId: 'invited' })),
    declineInvite: vi.fn(async () => undefined),
    clearRequestedRoom: vi.fn(),
    isRequestedRoom: vi.fn(() => false),
    approveJoinRequest: vi.fn(async () => undefined),
    requestRoomJoin: vi.fn(async () => undefined),
    setPresence: vi.fn(async () => undefined),
    invite: vi.fn(async () => undefined),
  };
  const session = new RoomSessionController(transport, voice, 'self');
  const invitations = new RoomInvitationCoordinator(social, session, 'self');
  return { transport, voice, social, session, invitations };
};

it('finishes creation and its invitation before entering a subsequently accepted room', async () => {
  const { transport, social, session, invitations } = setup();
  const pending = deferred<RoomStateDto>();
  transport.createRoom.mockReturnValueOnce(pending.promise);
  const creating = invitations.createTogether('friend', 'Singer');
  await vi.waitFor(() => expect(transport.createRoom).toHaveBeenCalledOnce());
  const accepting = invitations.accept('invite', 'Singer');
  await Promise.resolve();
  const acceptedBeforeCreation = social.acceptInvite.mock.calls.length;
  pending.resolve(snapshot('created'));
  await Promise.all([creating, accepting]);

  expect(acceptedBeforeCreation).toBe(0);
  expect(social.setPresence).toHaveBeenCalledWith({
    displayName: 'Singer',
    participantId: 'self',
    roomId: 'created',
  });
  expect(social.invite).toHaveBeenCalledWith('friend', 'created');
  expect(transport.leaveRoom).toHaveBeenCalledWith('created');
  expect(transport.joinRoom).toHaveBeenCalledWith('invited', 'Singer');
  expect(session.getRoom()?.code).toBe('invited');
  expect(invitations.isHandled('invite')).toBe(true);
});

it('does not repurpose an earlier invitation join as a successful room creation', async () => {
  const { transport, social, session, invitations } = setup();
  const pending = deferred<RoomStateDto>();
  transport.joinRoom.mockReturnValueOnce(pending.promise);
  const accepting = invitations.accept('invite', 'Singer');
  await vi.waitFor(() => expect(transport.joinRoom).toHaveBeenCalledOnce());
  const creating = invitations
    .createTogether('friend', 'Singer')
    .catch((error: unknown) => error);
  pending.resolve(snapshot('invited'));
  await accepting;

  expect(await creating).toEqual(
    new Error('Leave the current room before joining another'),
  );
  expect(transport.createRoom).not.toHaveBeenCalled();
  expect(transport.leaveRoom).not.toHaveBeenCalled();
  expect(social.setPresence).not.toHaveBeenCalled();
  expect(social.invite).not.toHaveBeenCalled();
  expect(session.getRoom()?.code).toBe('invited');
});

it('retains the explicit leave requirement when creation is requested in an existing room', async () => {
  const { transport, social, session, invitations } = setup();
  await session.join('Singer', 'existing');

  await expect(invitations.createTogether('friend', 'Singer')).rejects.toThrow(
    'Leave the current room before joining another',
  );

  expect(transport.createRoom).not.toHaveBeenCalled();
  expect(transport.leaveRoom).not.toHaveBeenCalled();
  expect(social.invite).not.toHaveBeenCalled();
  expect(session.getRoom()?.code).toBe('existing');
});

it.each(['createRoom', 'setPresence', 'invite'] as const)(
  'keeps later acceptance available after creation fails at %s',
  async (phase) => {
    const { transport, social, session, invitations } = setup();
    const pending = deferred<never>();
    const failing =
      phase === 'createRoom' ? transport.createRoom : social[phase];
    failing.mockReturnValueOnce(pending.promise);
    const creating = invitations
      .createTogether('friend', 'Singer')
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(failing).toHaveBeenCalledOnce());
    const accepting = invitations
      .accept('invite', 'Singer')
      .catch((error: unknown) => error);
    await Promise.resolve();
    const acceptedBeforeFailure = social.acceptInvite.mock.calls.length;
    pending.reject(new Error('Creation failed'));

    expect(await creating).toEqual(new Error('Creation failed'));
    expect(await accepting).toBeUndefined();
    expect(acceptedBeforeFailure).toBe(0);
    expect(transport.joinRoom).toHaveBeenCalledWith('invited', 'Singer');
    expect(session.getRoom()?.code).toBe('invited');
    expect(invitations.isHandled('invite')).toBe(true);
  },
);

it('allows queued creation after server acceptance fails without joining a room', async () => {
  const { transport, social, session, invitations } = setup();
  const pending = deferred<{ roomId: string }>();
  social.acceptInvite.mockReturnValueOnce(pending.promise);
  const accepting = invitations
    .accept('invite', 'Singer')
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(social.acceptInvite).toHaveBeenCalledOnce());
  const creating = invitations.createTogether('friend', 'Singer');
  const createdBeforeFailure = transport.createRoom.mock.calls.length;
  pending.reject(new Error('Acceptance failed'));

  expect(await accepting).toEqual(new Error('Acceptance failed'));
  await creating;
  expect(createdBeforeFailure).toBe(0);
  expect(social.invite).toHaveBeenCalledWith('friend', 'created');
  expect(session.getRoom()?.code).toBe('created');
  expect(invitations.isHandled('invite')).toBe(false);
});

it('retries an accepted invitation after a failed join and subsequent room creation', async () => {
  const { transport, social, session, invitations } = setup();
  const pending = deferred<RoomStateDto>();
  transport.joinRoom.mockReturnValueOnce(pending.promise);
  const accepting = invitations
    .accept('invite', 'Singer')
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(transport.joinRoom).toHaveBeenCalledOnce());
  const creating = invitations
    .createTogether('friend', 'Singer')
    .catch((error: unknown) => error);
  pending.reject(new Error('Join failed'));

  expect(await accepting).toEqual(new Error('Join failed'));
  expect(await creating).toBeUndefined();
  expect(session.getRoom()?.code).toBe('created');
  expect(invitations.canRetry('invite')).toBe(true);
  await invitations.accept('invite', 'Singer');
  expect(social.acceptInvite).toHaveBeenCalledOnce();
  expect(transport.leaveRoom).toHaveBeenCalledWith('created');
  expect(transport.joinRoom).toHaveBeenCalledTimes(2);
  expect(session.getRoom()?.code).toBe('invited');
  expect(social.clearRequestedRoom).toHaveBeenCalledWith('invited');
});
