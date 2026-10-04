import { useState } from "react";
import { useText } from "../../i18n/useText";
import { StatCard } from "../library/StatCard";
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
      <button type="button" className="statCardButton" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <StatCard icon="users" value={friends.length} label={t("friendsStat", { online })} />
        {waiting > 0 && <span className="statCardBadge" aria-label={t("incomingRequests")}>{waiting}</span>}
      </button>
      <FriendsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
};
