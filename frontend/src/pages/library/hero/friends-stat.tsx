import { observer } from "mobx-react-lite";
import { store } from "../../../providers/store";
import { useState } from "react";
import { StatTile, tr, useLocale } from "@neo-ui-kit/react";
import { ru } from "../../../i18n/messages.ru";
import { FriendsDialog } from "../modals/friends/index";

import "../../../features/social/social.css";

/** The library's headline card for friends: how many there are and how many have the app open. */
export const FriendsStat = observer(() => {
  useLocale();
  const inbox = store.inbox;
  const [open, setOpen] = useState(false);
  const friends = inbox.type === "inbox" ? inbox.friends : [];
  const online = friends.filter(
    (friend) => friend.presence !== "Offline",
  ).length;
  const waiting = inbox.type === "inbox" ? inbox.friendRequests.length : 0;

  return (
    <>
      <StatTile
        icon="users"
        tilt={false}
        value={friends.length}
        label={tr(ru.friendsStat, { online })}
        aria-haspopup="dialog"
        badge={waiting > 0 ? waiting : undefined}
        badgeLabel={tr(ru.incomingRequests)}
        onClick={() => setOpen(true)}
      />
      <FriendsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
});
