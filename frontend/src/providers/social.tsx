import { tr } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { FriendRelationsCoordinator } from '../application/social/FriendRelationsCoordinator';
import { RoomInvitationCoordinator } from '../application/social/RoomInvitationCoordinator';
import type { SocialNotice } from '../contracts/social';
import { SocialAlerts } from '../features/social/SocialAlerts';
import { desktopClient } from '../services/desktopClient';
import { participantId } from '../services/roomMappers';
import { socialClient } from '../services/socialClient';
import { observeOperation } from '../shared/errors';
import { roomSession } from './application';
import { useNotify, type NotificationIntent } from './notifications';
import { store } from './store';

export const friendRelations = new FriendRelationsCoordinator(
  socialClient,
  desktopClient,
);
const invitationsBySession = new WeakMap<
  typeof roomSession,
  RoomInvitationCoordinator
>();

export const useRoomInvitations = (): RoomInvitationCoordinator => {
  const session = roomSession;
  let invitations = invitationsBySession.get(session);
  if (!invitations) {
    invitations = new RoomInvitationCoordinator(
      socialClient,
      session,
      participantId,
    );
    invitationsBySession.set(session, invitations);
  }
  return invitations;
};

const noticeTexts = {
  FriendAccepted: ['friendAccepted', 'success'],
  InviteAccepted: ['inviteAccepted', 'success'],
  InviteDeclined: ['inviteDeclined', 'warning'],
  JoinRequested: ['joinRequested', 'info'],
} as const satisfies Record<
  SocialNotice['kind'],
  readonly [string, NotificationIntent]
>;

export const SocialConnection = observer(() => {
  const { inbox, setInbox } = store;
  const { preferences } = store;
  const { room } = store.online;
  const notify = useNotify();

  useEffect(
    () =>
      socialClient.subscribe((next) => {
        setInbox(next);
        if (next.type !== 'inbox') return;
        for (const notice of next.notices) {
          const [key, intent] = noticeTexts[notice.kind];
          notify(tr(key, { name: notice.person.displayName }), intent);
        }
      }),
    [notify],
  );

  const roomId = room?.code ?? null;
  useEffect(() => {
    void observeOperation(
      'errors.presence',
      socialClient.setPresence({
        displayName: preferences.displayName,
        participantId,
        roomId,
      }),
    ).catch(() => undefined);
  }, [preferences.displayName, roomId]);

  return <SocialAlerts inbox={inbox} />;
});
