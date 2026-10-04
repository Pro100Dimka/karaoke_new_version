import { useState } from "react";
import { Dialog, Tabs, Typography } from "@ad-voice/ui";
import { useText } from "../../i18n/useText";
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
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }} className="friendsDialog" width="wide" icon="users"
      title={t("friends")} description={t("friendsIntro")} closeLabel={t("closeDialog")} cancelLabel={false} confirmLabel={false}>
      {inbox.type !== "inbox" ? <Typography tone="muted">{t("socialOffline")}</Typography> : (
        <div className="socialStack">
          <Tabs<FriendsTab> value={tab} onValueChange={setTab} label={t("friends")} items={[
            { value: "friends", label: t("friendsTabFriends"), icon: "users" },
            { value: "requests", label: incoming ? `${t("friendsTabRequests")} · ${incoming}` : t("friendsTabRequests"), icon: "person" },
            { value: "history", label: t("friendsTabHistory"), icon: "history" },
          ]} />
          {tab === "friends" && <FriendsList inbox={inbox} />}
          {tab === "requests" && <FriendRequests inbox={inbox} />}
          {tab === "history" && <RoomHistory />}
        </div>
      )}
    </Dialog>
  );
};
