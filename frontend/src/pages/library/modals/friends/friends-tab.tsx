import { friendRelations } from "../../../../providers/social";
import { observer } from "mobx-react-lite";
import { store } from "../../../../providers/store";
import { ru } from "../../../../i18n/messages.ru";
import { IconButton, tr, useLocale } from "@neo-ui-kit/react";

import { useRoomInvitations } from "../../../../providers/social";
import { ask } from "../../../../providers/dialog";
import type { OnlineInbox, SocialPerson } from "../../../../contracts/social";
import FriendsRows from "./list";
import { presenceText } from "../../../../features/social/socialFormat";
import { useSocialAction } from "../../../../features/social/useSocialAction";

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
      return friend.presence === "Online"
        ? tr(ru.createRoomTogether)
        : tr(ru.inviteNeedsRoom);
    return friend.roomId === room.code
      ? tr(ru.inviteInYourRoom)
      : tr(ru.inviteToRoom);
  };
  const remove = async (friend: SocialPerson) => {
    const choice = await ask({
      title: tr(ru.removeFriend),
      body: tr(ru.removeFriendConfirm, { name: friend.displayName }),
      tone: "warning",
      actions: [
        { id: "cancel", label: tr(ru.cancel) },
        { id: "remove", label: tr(ru.removeFriend), appearance: "primary" },
      ],
    });
    if (choice === "remove")
      await run(
        () => friendRelations.remove(friend.accountId),
        tr(ru.friendRemoved, { name: friend.displayName }),
      );
  };
  const createTogether = (friend: SocialPerson) =>
    run(
      () =>
        invitations.createTogether(
          friend.accountId,
          preferences.displayName || inbox.me.displayName,
        ),
      tr(ru.inviteSent, { name: friend.displayName }),
    );

  return <FriendsRows rows={friends} detail={(friend) => presenceText(friend, preferences.language)}
    actions={(friend) => {
      const hostedRoomId = !room && friend.isRoomHost ? friend.roomId : null;
      const canCreateTogether = !room && friend.presence === "Online";
      return (              <>
                {hostedRoomId && (
                  <IconButton
                    size="sm"
                    variant="secondary"
                    icon="login"
                    label={tr(ru.requestRoomJoin)}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          invitations.requestJoin(
                            friend.accountId,
                            hostedRoomId,
                          ),
                        tr(ru.roomJoinRequested, { name: friend.displayName }),
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
                    friend.presence === "Offline" ||
                    friend.roomId === room?.code
                  }
                  onClick={() =>
                    room
                      ? void run(
                          () => invitations.invite(friend.accountId, room.code),
                          tr(ru.inviteSent, { name: friend.displayName }),
                        )
                      : void createTogether(friend)
                  }
                />
                <IconButton
                  size="sm"
                    variant="secondary"
                  icon="close"
                  label={tr(ru.removeFriend)}
                  disabled={busy}
                  onClick={() => void remove(friend)}
                />
              </>      );
    }} />;
});