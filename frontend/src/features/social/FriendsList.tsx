import { IconButton, Typography } from "@ad-voice/ui";
import { useApp, useRoomSession } from "../../app/AppContext";
import { useAsk } from "../../app/DialogProvider";
import type { OnlineInbox, SocialPerson } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { socialClient } from "../../services/socialClient";
import { participantId } from "../../services/roomMappers";
import { PersonRow } from "./PersonRow";
import { presenceText } from "./socialFormat";
import { useSocialAction } from "./useSocialAction";

const presenceOrder = { InRoom: 0, Online: 1, Offline: 2 } as const;

/** Friends, those with the app open first; invite them into your room or remove them. */
export const FriendsList = ({ inbox }: { inbox: OnlineInbox }) => {
  const t = useText();
  const ask = useAsk();
  const { room, preferences } = useApp();
  const roomSession = useRoomSession();
  const { busy, run } = useSocialAction();
  const friends = [...inbox.friends].sort(
    (a, b) =>
      presenceOrder[a.presence] - presenceOrder[b.presence] ||
      a.displayName.localeCompare(b.displayName),
  );

  const inviteLabel = (friend: SocialPerson): string => {
    if (!room)
      return friend.presence === "Online"
        ? t("createRoomTogether")
        : t("inviteNeedsRoom");
    return friend.roomId === room.code
      ? t("inviteInYourRoom")
      : t("inviteToRoom");
  };
  const remove = async (friend: SocialPerson) => {
    const choice = await ask({
      title: t("removeFriend"),
      body: t("removeFriendConfirm", { name: friend.displayName }),
      tone: "warning",
      actions: [
        { id: "cancel", label: t("cancel") },
        { id: "remove", label: t("removeFriend"), appearance: "primary" },
      ],
    });
    if (choice === "remove")
      await run(
        () => socialClient.removeFriend(friend.accountId),
        t("friendRemoved", { name: friend.displayName }),
      );
  };
  const createTogether = (friend: SocialPerson) =>
    run(
      async () => {
        const displayName = preferences.displayName || inbox.me.displayName;
        const created = await roomSession.join(displayName);
        await socialClient.setPresence({
          displayName,
          participantId,
          roomId: created.code,
        });
        await socialClient.invite(friend.accountId, created.code);
      },
      t("inviteSent", { name: friend.displayName }),
    );

  if (friends.length === 0)
    return <Typography tone="muted">{t("friendsEmpty")}</Typography>;
  return (
    <ul className="personList">
      {friends.map((friend) => {
        const hostedRoomId = !room && friend.isRoomHost ? friend.roomId : null;
        const canCreateTogether = !room && friend.presence === "Online";
        return (
          <PersonRow
            key={friend.accountId}
            accountId={friend.accountId}
            avatarVersion={friend.avatarVersion}
            name={friend.displayName}
            presence={friend.presence}
            detail={presenceText(friend, t, preferences.language)}
            actions={
              <>
                {hostedRoomId && (
                  <IconButton
                    size="sm"
                    icon="login"
                    label={t("requestRoomJoin")}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          socialClient.requestRoomJoin(
                            friend.accountId,
                            hostedRoomId,
                          ),
                        t("roomJoinRequested", { name: friend.displayName }),
                      )
                    }
                  />
                )}
                <IconButton
                  size="sm"
                  variant="primary"
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
                          () =>
                            socialClient.invite(friend.accountId, room.code),
                          t("inviteSent", { name: friend.displayName }),
                        )
                      : void createTogether(friend)
                  }
                />
                <IconButton
                  size="sm"
                  icon="close"
                  label={t("removeFriend")}
                  disabled={busy}
                  onClick={() => void remove(friend)}
                />
              </>
            }
          />
        );
      })}
    </ul>
  );
};
