import { useState } from "react";
import { StatTile } from "@ad-voice/ui";
import { useText } from "../../i18n/useText";
import { FriendsDialog } from "./FriendsDialog";
import { useSocial } from "./SocialContext";
import "./social.css";

/** The library's headline card for friends: how many there are and how many have the app open. */
export const FriendsStat = () => {
  const t = useText();
  const inbox = useSocial();
  const [open, setOpen] = useState(false);
  const friends = inbox.type === "inbox" ? inbox.friends : [];
  const online = friends.filter(friend => friend.presence !== "Offline").length;
  const waiting = inbox.type === "inbox" ? inbox.friendRequests.length : 0;

  return (
    <>
      <StatTile icon="users" value={friends.length} label={t("friendsStat", { online })} aria-haspopup="dialog"
        badge={waiting > 0 ? waiting : undefined} badgeLabel={t("incomingRequests")} onClick={() => setOpen(true)} />
      <FriendsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
};
