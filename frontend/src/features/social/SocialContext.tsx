import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useApp } from "../../app/AppContext";
import {
  useNotify,
  type NotificationIntent,
} from "../../app/NotificationsProvider";
import type { SocialInbox, SocialNotice } from "../../contracts/social";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { participantId } from "../../services/roomMappers";
import { socialClient } from "../../services/socialClient";
import { SocialAlerts } from "./SocialAlerts";

const offline: SocialInbox = { type: "offline" };
const SocialContext = createContext<SocialInbox>(offline);

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
      {children}
      <SocialAlerts inbox={inbox} />
    </SocialContext.Provider>
  );
};

export const useSocial = (): SocialInbox => useContext(SocialContext);
