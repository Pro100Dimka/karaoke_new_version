import { tr } from "@neo-ui-kit/react";
import { observer } from 'mobx-react-lite';
import { store } from './store';
import { useEffect } from "react";
import { roomSession } from "./application";
import {
  useNotify,
  type NotificationIntent,
} from "./notifications";
import type { SocialNotice } from "../contracts/social";
import type { MessageKey } from "../i18n/messages";
import { ru } from "../i18n/messages.ru";
import { participantId } from "../services/roomMappers";
import { socialClient } from "../services/socialClient";
import { RoomInvitationCoordinator } from "../application/social/RoomInvitationCoordinator";
import { FriendRelationsCoordinator } from "../application/social/FriendRelationsCoordinator";
import { desktopClient } from "../services/desktopClient";
import { SocialAlerts } from "../features/social/SocialAlerts";

export const friendRelations = new FriendRelationsCoordinator(socialClient, desktopClient);
const invitationsBySession = new WeakMap<typeof roomSession, RoomInvitationCoordinator>();

export const useRoomInvitations = (): RoomInvitationCoordinator => {
  const session = roomSession;
  let invitations = invitationsBySession.get(session);
  if (!invitations) {
    invitations = new RoomInvitationCoordinator(socialClient, session, participantId);
    invitationsBySession.set(session, invitations);
  }
  return invitations;
};

const noticeTexts = {
  FriendAccepted: ["friendAccepted", "success"],
  InviteAccepted: ["inviteAccepted", "success"],
  InviteDeclined: ["inviteDeclined", "warning"],
  JoinRequested: ["joinRequested", "info"],
} as const satisfies Record<
  SocialNotice["kind"],
  readonly [MessageKey, NotificationIntent]
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
        if (next.type !== "inbox") return;
        for (const notice of next.notices) {
          const [key, intent] = noticeTexts[notice.kind];
          notify(tr(ru[key], { name: notice.person.displayName }), intent);
        }
      }),
    [notify],
  );

  const roomId = room?.code ?? null;
  useEffect(() => {
    void socialClient
      .setPresence({
        displayName: preferences.displayName,
        participantId,
        roomId,
      })
      .catch(() => undefined);
  }, [preferences.displayName, roomId]);

  return <SocialAlerts inbox={inbox} />;
});
