import { friendRelations } from '../../providers/social';
import { observer } from 'mobx-react-lite';
import { store } from '../../providers/store';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { playNotificationSound } from '../../providers/notifications';
import {
  Button,
  Card,
  Stack,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';

import { useRoomInvitations } from '../../providers/social';
import type {
  OnlineInbox,
  SocialInbox,
  SocialInvite,
  SocialNotice,
  SocialPerson,
} from '../../contracts/social';
import { PersonAvatar } from './PersonAvatar';
import { useSocialAction } from './useSocialAction';
import './social.css';

const Alert = ({
  person,
  text,
  actions,
}: {
  person: SocialPerson;
  text: string;
  actions: ReactNode;
}) => (
  <Card
    border
    padding="sm"
    className="socialAlert"
    role="alertdialog"
    aria-label={text}
  >
    <Stack direction="row" gap={3} align="center">
      <PersonAvatar
        accountId={person.accountId}
        avatarVersion={person.avatarVersion}
        name={person.displayName}
      />
      <Typography>{text}</Typography>
    </Stack>
    <div className="socialAlertActions">{actions}</div>
  </Card>
);

type OnlineAlertProps = {
  inbox: OnlineInbox;
  roomRequests: readonly SocialNotice[];
  dismissRoomRequest(request: SocialNotice): void;
};

/**
 * Friend requests and room invitations waiting for an answer, in a corner of every screen. A
 * request put off with "Later" stays in the Friends window; an invitation expires with its room.
 */
const OnlineSocialAlerts = observer((props: OnlineAlertProps) => {
  const { inbox, roomRequests, dismissRoomRequest } = props;
  useLocale();
  const { preferences } = store;
  const invitations = useRoomInvitations();
  const invitationVersion = useSyncExternalStore(
    invitations.subscribe,
    invitations.getSnapshot,
  );
  const pendingInvites = invitations.availableInvites(inbox.invites);
  const friends = friendRelations;
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const attemptedApprovals = useRef(new Set<string>());
  const { busy, run } = useSocialAction();
  const acceptInvite = (invite: SocialInvite) =>
    run(() =>
      invitations.accept(
        invite,
        preferences.displayName || inbox.me.displayName,
      ),
    );
  useEffect(() => {
    invitations.prune(inbox.invites.map((invite) => invite.inviteId));
    const active = new Set(pendingInvites.map((invite) => invite.inviteId));
    for (const id of attemptedApprovals.current)
      if (!active.has(id)) attemptedApprovals.current.delete(id);
    if (busy) return;
    const approved = pendingInvites.find(
      (invite) =>
        invitations.isRequestedRoom(invite.roomId) &&
        !invitations.isHandled(invite.inviteId) &&
        !invitations.canRetry(invite.inviteId) &&
        !attemptedApprovals.current.has(invite.inviteId),
    );
    if (!approved) return;
    attemptedApprovals.current.add(approved.inviteId);
    void acceptInvite(approved);
  }, [inbox.invites, invitations, invitationVersion, busy]);
  const requests = inbox.friendRequests.filter(
    (person) => !later.has(person.accountId),
  );
  const invites = pendingInvites.filter(
    (invite) =>
      !invitations.isRequestedRoom(invite.roomId) ||
      invitations.canRetry(invite.inviteId) ||
      (attemptedApprovals.current.has(invite.inviteId) &&
        !invitations.isHandled(invite.inviteId)),
  );
  const heard = useRef(new Set<string>());
  useEffect(() => {
    const keys = [
      ...invites.map((invite) => `invite:${invite.inviteId}`),
      ...requests.map((person) => `friend:${person.accountId}`),
    ];
    if (keys.some((key) => !heard.current.has(key)))
      playNotificationSound('invitation');
    keys.forEach((key) => heard.current.add(key));
  }, [invites, requests]);

  return (
    <div className="socialAlerts" aria-live="polite">
      {invites.map((invite) => (
        <Alert
          key={invite.inviteId}
          person={invite.sender}
          text={tr('social.roomInviteAlert', {
            name: invite.sender.displayName,
          })}
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                disabled={busy || invitations.isHandled(invite.inviteId)}
                onClick={() => void acceptInvite(invite)}
              >
                {tr(
                  invitations.canRetry(invite.inviteId)
                    ? 'retry'
                    : 'social.acceptAction',
                )}
              </Button>
              <Button
                size="sm"
                icon="close"
                disabled={busy || invitations.isHandled(invite.inviteId)}
                onClick={() =>
                  void run(() => invitations.decline(invite.inviteId))
                }
              >
                {tr(
                  invitations.canRetry(invite.inviteId)
                    ? 'close'
                    : 'social.declineAction',
                )}
              </Button>
            </>
          }
        />
      ))}
      {roomRequests.map((request) => (
        <Alert
          key={`join:${request.person.accountId}:${request.roomId}`}
          person={request.person}
          text={tr('social.joinRequested', {
            name: request.person.displayName,
          })}
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                disabled={busy || !request.roomId}
                onClick={() => {
                  const roomId = request.roomId;
                  if (roomId)
                    void run(async () => {
                      await invitations.approve(
                        request.person.accountId,
                        roomId,
                      );
                      dismissRoomRequest(request);
                    });
                }}
              >
                {tr('social.acceptAction')}
              </Button>
              <Button
                size="sm"
                icon="close"
                disabled={busy}
                onClick={() => dismissRoomRequest(request)}
              >
                {tr('close')}
              </Button>
            </>
          }
        />
      ))}
      {requests.map((person) => (
        <Alert
          key={person.accountId}
          person={person}
          text={tr('social.friendRequestAlert', { name: person.displayName })}
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                disabled={busy}
                onClick={() => void run(() => friends.accept(person.accountId))}
              >
                {tr('social.acceptAction')}
              </Button>
              <Button
                size="sm"
                icon="close"
                disabled={busy}
                onClick={() =>
                  void run(() => friends.decline(person.accountId))
                }
              >
                {tr('social.declineAction')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="clock"
                disabled={busy}
                onClick={() =>
                  setLater((current) => new Set(current).add(person.accountId))
                }
              >
                {tr('social.laterAction')}
              </Button>
            </>
          }
        />
      ))}
    </div>
  );
});

export const SocialAlerts = observer(({ inbox }: { inbox: SocialInbox }) => {
  const roomId = store.online.room?.code;
  const [roomRequests, setRoomRequests] = useState<readonly SocialNotice[]>([]);
  // Join requests are one-shot notices, unlike invitations. Keep the action available
  // across later inbox pushes and a temporary social disconnect until the host answers.
  useEffect(() => {
    setRoomRequests((current) => {
      const retained = current.filter((request) => request.roomId === roomId);
      const incoming =
        inbox.type === 'inbox'
          ? inbox.notices.filter(
              (notice) =>
                notice.kind === 'JoinRequested' && notice.roomId === roomId,
            )
          : [];
      if (!incoming.length && retained.length === current.length)
        return current;
      return [
        ...new Map(
          [...retained, ...incoming].map((request) => [
            request.person.accountId,
            request,
          ]),
        ).values(),
      ];
    });
  }, [inbox, roomId]);
  const dismissRoomRequest = (answered: SocialNotice) => {
    setRoomRequests((current) =>
      current.filter(
        (request) =>
          request.roomId !== answered.roomId ||
          request.person.accountId !== answered.person.accountId,
      ),
    );
  };
  return inbox.type === 'inbox' ? (
    <OnlineSocialAlerts
      inbox={inbox}
      roomRequests={roomRequests.filter((request) => request.roomId === roomId)}
      dismissRoomRequest={dismissRoomRequest}
    />
  ) : null;
});
