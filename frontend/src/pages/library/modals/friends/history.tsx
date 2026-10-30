import { friendRelations } from "../../../../providers/social";
import { socialClient } from "../../../../services/socialClient";
import { observer } from "mobx-react-lite";
import { store } from "../../../../providers/store";
import { ru } from "../../../../i18n/messages.ru";
import { useEffect, useState } from "react";
import { IconButton, ProgressBar, Typography, tr, useLocale } from "@neo-ui-kit/react";
import type {
  RoomStay,
  RoomStayPerson,
  SocialRelation,
} from "../../../../contracts/social";

import { PersonRow } from "../../../../features/social/PersonRow";
import { durationText } from "../../../../features/social/socialFormat";
import { useSocialAction } from "../../../../features/social/useSocialAction";

/**
 * The rooms this person was in: when, for how long, and with whom. Anyone who is not a friend yet
 * can be added from here.
 */
export const RoomHistory = observer(() => {
  useLocale();
  const { preferences } = store;
  const { busy, run } = useSocialAction();
  const friends = friendRelations;
  const [stays, setStays] = useState<RoomStay[]>();
  const [failed, setFailed] = useState(false);
  // What the asker did from this list; the list itself is fetched once when the tab opens.
  const [relations, setRelations] = useState<Record<string, SocialRelation>>(
    {},
  );

  useEffect(() => {
    let active = true;
    socialClient.history().then(
      (loaded) => active && setStays(loaded),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, []);

  const add = (accountId: string, name: string) =>
    run(
      async () => {
        const relation = await friends.requestAccount(accountId);
        setRelations((current) => ({ ...current, [accountId]: relation }));
      },
      tr(ru.friendRequestSent, { name }),
    );

  const personActions = ({ person, displayName }: RoomStayPerson) => {
    if (!person) return undefined;
    const relation = relations[person.accountId] ?? person.relation;
    if (relation === "Friend" || relation === "Self") return undefined;
    if (relation === "Requested")
      return (
        <IconButton
          size="sm"
          icon="check"
          label={tr(ru.requestPending)}
          disabled
        />
      );
    return (
      <IconButton
        size="sm"
        icon="person"
        label={tr(ru.addFriend)}
        disabled={busy}
        onClick={() => void add(person.accountId, displayName)}
      />
    );
  };

  if (failed)
    return <Typography tone="muted">{tr(ru.roomNetworkUnavailable)}</Typography>;
  if (!stays)
    return <ProgressBar indeterminate label={tr(ru.friendsTabHistory)} />;
  if (stays.length === 0)
    return <Typography tone="muted">{tr(ru.roomHistoryEmpty)}</Typography>;
  return (
    <ol className="roomStays">
      {stays.map((stay) => (
        <li key={stay.roomId} className="roomStay">
          <Typography as="strong" variant="title">
            {new Date(stay.joinedAt).toLocaleString(preferences.language, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </Typography>
          <Typography variant="body-sm" tone="muted">
            {stay.leftAt
              ? tr(ru.historySpent, { duration: durationText(stay.seconds) })
              : tr(ru.historyStillHere)}
          </Typography>
          {stay.people.length === 0 ? (
            <Typography variant="body-sm" tone="muted">
              {tr(ru.historyAlone)}
            </Typography>
          ) : (
            <ul className="personList">
              {stay.people.map((item) => (
                <PersonRow
                  key={item.participantId}
                  accountId={item.person?.accountId}
                  avatarVersion={item.person?.avatarVersion}
                  name={item.person?.displayName || item.displayName}
                  detail={item.person ? undefined : tr(ru.historyUnknownPerson)}
                  actions={personActions(item)}
                />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
});
