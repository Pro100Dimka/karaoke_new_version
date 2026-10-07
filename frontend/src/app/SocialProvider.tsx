import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useApp, useRoomSession } from "./AppContext";
import {
  useNotify,
  type NotificationIntent,
} from "./NotificationsProvider";
import type { SocialInbox, SocialNotice } from "../contracts/social";
import type { MessageKey } from "../i18n/messages";
import { useText } from "../i18n/useText";
import { participantId } from "../services/roomMappers";
import { socialClient } from "../services/socialClient";
import { RoomInvitationCoordinator } from "../application/social/RoomInvitationCoordinator";
import { FriendRelationsCoordinator } from "../application/social/FriendRelationsCoordinator";
import { desktopClient } from "../services/desktopClient";
import type { SocialDirectoryPort } from "../application/social/SocialDirectory";
import { SocialAlerts } from "../features/social/SocialAlerts";

const offline: SocialInbox = { type: "offline" };
const SocialContext = createContext<SocialInbox>(offline);
const InvitationContext = createContext<RoomInvitationCoordinator | null>(null);
const FriendRelationsContext = createContext<FriendRelationsCoordinator | null>(null);
const DirectoryContext = createContext<SocialDirectoryPort | null>(null);

const noticeTexts = {
  FriendAccepted: ["friendAccepted", "success"],
  InviteAccepted: ["inviteAccepted", "success"],
  InviteDeclined: ["inviteDeclined", "warning"],
  JoinRequested: ["joinRequested", "info"],
} as const satisfies Record<
  SocialNotice["kind"],
  readonly [MessageKey, NotificationIntent]
>;

/**
 * Friends for the whole app: the inbox the server pushes over the app's socket, this app's name and
 * room told to the server when they change, answers shown once, and requests waiting for an answer.
 */
export const SocialProvider = ({ children }: { children: ReactNode }) => {
  const [inbox, setInbox] = useState<SocialInbox>(offline);
  const roomSession = useRoomSession();
  const [invitations] = useState(() =>
    new RoomInvitationCoordinator(socialClient, roomSession, participantId));
  const [friends] = useState(() => new FriendRelationsCoordinator(socialClient, desktopClient));
  const { preferences, room } = useApp();
  const notify = useNotify();
  const t = useText();

  useEffect(
    () =>
      socialClient.subscribe((next) => {
        setInbox(next);
        if (next.type !== "inbox") return;
        for (const notice of next.notices) {
          const [key, intent] = noticeTexts[notice.kind];
          notify(t(key, { name: notice.person.displayName }), intent);
        }
      }),
    [notify, t],
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

  return (
    <SocialContext.Provider value={inbox}>
      <InvitationContext.Provider value={invitations}>
        <FriendRelationsContext.Provider value={friends}>
          <DirectoryContext.Provider value={socialClient}>
            {children}
            <SocialAlerts inbox={inbox} />
          </DirectoryContext.Provider>
        </FriendRelationsContext.Provider>
      </InvitationContext.Provider>
    </SocialContext.Provider>
  );
};

export const useSocial = (): SocialInbox => useContext(SocialContext);

export const useRoomInvitations = (): RoomInvitationCoordinator => {
  const value = useContext(InvitationContext);
  if (!value) throw new Error("useRoomInvitations must be used inside SocialProvider");
  return value;
};

export const useFriendRelations = (): FriendRelationsCoordinator => {
  const value = useContext(FriendRelationsContext);
  if (!value) throw new Error("useFriendRelations must be used inside SocialProvider");
  return value;
};

export const useSocialDirectory = (): SocialDirectoryPort => {
  const value = useContext(DirectoryContext);
  if (!value) throw new Error("useSocialDirectory must be used inside SocialProvider");
  return value;
};
