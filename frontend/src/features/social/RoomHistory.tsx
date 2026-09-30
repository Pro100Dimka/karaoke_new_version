import { Check, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "../../app/AppContext";
import type { RoomStay, RoomStayPerson, SocialRelation } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { socialClient } from "../../services/socialClient";
import { IconButton, Progress, Typography } from "../../theme/ui";
import { PersonRow } from "./PersonRow";
import { durationText } from "./socialFormat";
import { useSocialAction } from "./useSocialAction";

/**
 * The rooms this person was in: when, for how long, and with whom. Anyone who is not a friend yet
 * can be added from here.
 */
export const RoomHistory = () => {
  const t = useText();
  const { preferences } = useApp();
  const { busy, run } = useSocialAction();
  const [stays, setStays] = useState<RoomStay[]>();
  const [failed, setFailed] = useState(false);
  // What the asker did from this list; the list itself is fetched once when the tab opens.
  const [relations, setRelations] = useState<Record<string, SocialRelation>>({});

  useEffect(() => {
    let active = true;
    socialClient.history().then(
      loaded => active && setStays(loaded),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, []);

  const add = (accountId: string, name: string) => run(async () => {
    const { relation } = await socialClient.requestFriend({ accountId });
    setRelations(current => ({ ...current, [accountId]: relation }));
  }, t("friendRequestSent", { name }));

  const personActions = ({ person, displayName }: RoomStayPerson) => {
    if (!person) return undefined;
    const relation = relations[person.accountId] ?? person.relation;
    if (relation === "Friend" || relation === "Self") return undefined;
    if (relation === "Requested")
      return <IconButton size="sm" variant="outline" icon={Check} label={t("requestPending")} title={t("requestPending")} disabled />;
    return <IconButton size="sm" variant="outline" icon={UserPlus} label={t("addFriend")} title={t("addFriend")} disabled={busy}
      onClick={() => void add(person.accountId, displayName)} />;
  };

  if (failed) return <Typography variant="body1" tone="muted">{t("roomNetworkUnavailable")}</Typography>;
  if (!stays) return <Progress />;
  if (stays.length === 0) return <Typography variant="body1" tone="muted">{t("roomHistoryEmpty")}</Typography>;
  return (
    <ol className="roomStays">
      {stays.map(stay => (
        <li key={stay.roomId} className="roomStay">
          <Typography variant="body1" className="roomStayWhen">
            {new Date(stay.joinedAt).toLocaleString(preferences.language, { dateStyle: "medium", timeStyle: "short" })}
          </Typography>
          <Typography variant="body2" tone="muted">
            {stay.leftAt ? t("historySpent", { duration: durationText(stay.seconds, t) }) : t("historyStillHere")}
          </Typography>
          {stay.people.length === 0
            ? <Typography variant="body2" tone="muted">{t("historyAlone")}</Typography>
            : <ul className="personList">
              {stay.people.map(item => (
                <PersonRow
                  key={item.participantId}
                  accountId={item.person?.accountId}
                  avatarVersion={item.person?.avatarVersion}
                  name={item.person?.displayName || item.displayName}
                  detail={item.person ? undefined : t("historyUnknownPerson")}
                  actions={personActions(item)}
                />
              ))}
            </ul>}
        </li>
      ))}
    </ol>
  );
};
