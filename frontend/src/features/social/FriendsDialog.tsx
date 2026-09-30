import { UsersRound } from "lucide-react";
import { useState } from "react";
import { useText } from "../../i18n/useText";
import { Modal, Tabs, Typography } from "../../theme/ui";
import { FriendRequests } from "./FriendRequests";
import { FriendsList } from "./FriendsList";
import { RoomHistory } from "./RoomHistory";
import { useSocial } from "./SocialContext";

type FriendsTab = "friends" | "requests" | "history";

/** Friends, friend requests and the rooms one has been in, in one window. */
export const FriendsDialog = ({ open, onClose }: { open: boolean; onClose(): void }) => {
  const t = useText();
  const inbox = useSocial();
  const [tab, setTab] = useState<FriendsTab>("friends");
  const incoming = inbox.type === "inbox" ? inbox.friendRequests.length : 0;

  return (
    <Modal
      isOpen={open}
      portal
      size="md"
      onClose={onClose}
      ariaLabel={t("friends")}
      closeAriaLabel={t("closeDialog")}
      titleProps={{ icon: UsersRound, eyebrow: t("onlineRoom"), title: t("friends"), description: t("friendsIntro") }}
    >
      {inbox.type !== "inbox"
        ? <Typography variant="body1" tone="muted">{t("socialOffline")}</Typography>
        : <Tabs<FriendsTab>
          value={tab}
          onChange={setTab}
          items={[
            { value: "friends", label: t("friendsTabFriends"), content: <FriendsList inbox={inbox} /> },
            {
              value: "requests",
              label: incoming ? `${t("friendsTabRequests")} · ${incoming}` : t("friendsTabRequests"),
              content: <FriendRequests inbox={inbox} />,
            },
            { value: "history", label: t("friendsTabHistory"), content: tab === "history" ? <RoomHistory /> : null },
          ]}
        />}
    </Modal>
  );
};
