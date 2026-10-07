import { useEffect, useState } from "react";
import { IconButton, ProgressBar, Typography } from "@ad-voice/ui";
import { useApp } from "../../app/AppContext";
import type {
  RoomStay,
  RoomStayPerson,
  SocialRelation,
} from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { useFriendRelations, useSocialDirectory } from "../../app/SocialProvider";
import { PersonRow } from "./PersonRow";
import { durationText } from "./socialFormat";
import { useSocialAction } from "./useSocialAction";

/**
 * The rooms this person was in: when, for how long, and with whom. Anyone who is not a friend yet
 * can be added from here.
 */
export const RoomHistory = () => {
  const t = useText();
  const { preferences } = useApp("preferences");
  const { busy, run } = useSocialAction();
  const friends = useFriendRelations();
  const directory = useSocialDirectory();
  const [stays, setStays] = useState<RoomStay[]>();
  const [failed, setFailed] = useState(false);
  // What the asker did from this list; the list itself is fetched once when the tab opens.
  const [relations, setRelations] = useState<Record<string, SocialRelation>>(
    {},
  );

  useEffect(() => {
    let active = true;
    directory.history().then(
      (loaded) => active && setStays(loaded),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [directory]);

  const add = (accountId: string, name: string) =>
    run(
      async () => {
        const relation = await friends.requestAccount(accountId);
        setRelations((current) => ({ ...current, [accountId]: relation }));
      },
      t("friendRequestSent", { name }),
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
          label={t("requestPending")}
          disabled
        />
      );
    return (
      <IconButton
        size="sm"
        icon="person"
        label={t("addFriend")}
        disabled={busy}
        onClick={() => void add(person.accountId, displayName)}
      />
    );
  };

  if (failed)
    return <Typography tone="muted">{t("roomNetworkUnavailable")}</Typography>;
  if (!stays)
    return <ProgressBar indeterminate label={t("friendsTabHistory")} />;
  if (stays.length === 0)
    return <Typography tone="muted">{t("roomHistoryEmpty")}</Typography>;
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
              ? t("historySpent", { duration: durationText(stay.seconds, t) })
              : t("historyStillHere")}
          </Typography>
          {stay.people.length === 0 ? (
            <Typography variant="body-sm" tone="muted">
              {t("historyAlone")}
            </Typography>
          ) : (
            <ul className="personList">
              {stay.people.map((item) => (
                <PersonRow
                  key={item.participantId}
                  accountId={item.person?.accountId}
                  avatarVersion={item.person?.avatarVersion}
                  name={item.person?.displayName || item.displayName}
                  detail={item.person ? undefined : t("historyUnknownPerson")}
                  actions={personActions(item)}
                />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
};
