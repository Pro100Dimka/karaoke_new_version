import { IconButton, tr, useLocale } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import type { OnlineInbox, SocialPerson } from '../../../../contracts/social';
import { presenceText } from '../../../../features/social/socialFormat';
import { useSocialAction } from '../../../../features/social/useSocialAction';
import { ask } from '../../../../providers/dialog';
import {
  friendRelations,
  useRoomInvitations,
} from '../../../../providers/social';
import { store } from '../../../../providers/store';
import FriendsRows from './list';

const presenceOrder = { InRoom: 0, Online: 1, Offline: 2 } as const;

/** Friends, those with the app open first; invite them into your room or remove them. */
export const FriendsList = observer(({ inbox }: { inbox: OnlineInbox }) => {
  useLocale();
  const { preferences } = store;
  const { room } = store.online;
  const invitations = useRoomInvitations();
  const { busy, run } = useSocialAction();
  const friends = [...inbox.friends].sort(
    (a, b) =>
      presenceOrder[a.presence] - presenceOrder[b.presence] ||
      a.displayName.localeCompare(b.displayName),
  );

  const inviteLabel = (friend: SocialPerson): string => {
    if (!room)
      return friend.presence === 'Online'
        ? tr(`social.createRoomTogether`)
        : tr(`social.inviteNeedsRoom`);
    return friend.roomId === room.code
      ? tr(`social.inviteInYourRoom`)
      : tr(`social.inviteToRoom`);
  };
  const remove = async (friend: SocialPerson) => {
    const choice = await ask({
      title: tr(`social.removeFriend`),
      body: tr(`social.removeFriendConfirm`, { name: friend.displayName }),
      tone: 'warning',
      actions: [
        { id: 'cancel', label: tr(`cancel`) },
        {
          id: 'remove',
          label: tr(`social.removeFriend`),
          appearance: 'primary',
        },
      ],
    });
    if (choice === 'remove')
      await run(
        () => friendRelations.remove(friend.accountId),
        tr(`social.friendRemoved`, { name: friend.displayName }),
      );
  };
  const createTogether = (friend: SocialPerson) =>
    run(
      () =>
        invitations.createTogether(
          friend.accountId,
          preferences.displayName || inbox.me.displayName,
        ),
      tr(`social.inviteSent`, { name: friend.displayName }),
    );

  return (
    <FriendsRows
      rows={friends}
      detail={(friend) => presenceText(friend, preferences.language)}
      actions={(friend) => {
        const hostedRoomId = !room && friend.isRoomHost ? friend.roomId : null;
        const canCreateTogether = !room && friend.presence === 'Online';
        return (
          <>
            {hostedRoomId && (
              <IconButton
                size="sm"
                variant="secondary"
                icon="login"
                label={tr(`social.requestRoomJoin`)}
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      invitations.requestJoin(friend.accountId, hostedRoomId),
                    tr(`social.roomJoinRequested`, {
                      name: friend.displayName,
                    }),
                  )
                }
              />
            )}
            <IconButton
              size="sm"
              variant="secondary"
              icon="users"
              label={inviteLabel(friend)}
              disabled={
                busy ||
                (!room && !canCreateTogether) ||
                friend.presence === 'Offline' ||
                friend.roomId === room?.code
              }
              onClick={() =>
                room
                  ? void run(
                      () => invitations.invite(friend.accountId, room.code),
                      tr(`social.inviteSent`, { name: friend.displayName }),
                    )
                  : void createTogether(friend)
              }
            />
            <IconButton
              size="sm"
              variant="secondary"
              icon="close"
              label={tr(`social.removeFriend`)}
              disabled={busy}
              onClick={() => void remove(friend)}
            />
          </>
        );
      }}
    />
  );
});
