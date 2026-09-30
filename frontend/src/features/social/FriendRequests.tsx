import { Check, Copy, UserPlus, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useNotify } from "../../app/NotificationsProvider";
import type { OnlineInbox, SocialPerson } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { socialClient } from "../../services/socialClient";
import { Button, IconButton, Stack, TextField, Typography } from "../../theme/ui";
import { PersonRow } from "./PersonRow";
import { useSocialAction } from "./useSocialAction";

const Section = ({ title, people, render }: { title: string; people: SocialPerson[]; render(person: SocialPerson): ReactNode }) => (
  <section className="socialSection">
    <Typography variant="h4">{title}</Typography>
    {people.length ? <ul className="personList">{people.map(render)}</ul> : null}
  </section>
);

/** My friend code to share, a friend request by someone else's code, and requests both ways. */
export const FriendRequests = ({ inbox }: { inbox: OnlineInbox }) => {
  const t = useText();
  const notify = useNotify();
  const { busy, run } = useSocialAction();
  const [code, setCode] = useState("");

  const send = async (event: FormEvent) => {
    event.preventDefault();
    let name = "";
    const sent = await run(async () => {
      name = (await socialClient.requestFriend({ friendCode: code })).person.displayName;
    });
    if (!sent) return;
    setCode("");
    notify(t("friendRequestSent", { name }), "success");
  };
  const copy = async () => {
    await desktopClient.copyText(inbox.me.friendCode);
    notify(t("codeCopied"), "success");
  };

  return (
    <Stack gap="var(--space-4)">
      <section className="socialSection">
        <Typography variant="h4">{t("myFriendCode")}</Typography>
        <Stack direction="row" align="center" gap="var(--space-2)">
          <code className="friendCode">{inbox.me.friendCode}</code>
          <IconButton size="sm" variant="outline" icon={Copy} label={t("copyCode")} title={t("copyCode")} onClick={() => void copy()} />
        </Stack>
        <Typography variant="body2" tone="muted">{t("myFriendCodeHint")}</Typography>
      </section>
      <form className="friendCodeForm" onSubmit={event => void send(event)}>
        <TextField label={t("friendCodeField")} value={code} onChange={setCode} autoComplete="off" spellCheck={false} />
        <Button type="submit" disabled={busy || !code.trim()} startIcon={<UserPlus size={16} />}>{t("sendFriendRequest")}</Button>
      </form>
      <Section title={t("incomingRequests")} people={inbox.friendRequests} render={person => (
        <PersonRow key={person.accountId} accountId={person.accountId} avatarVersion={person.avatarVersion} name={person.displayName} actions={<>
          <IconButton size="sm" variant="outline" icon={Check} label={t("acceptAction")} title={t("acceptAction")} disabled={busy}
            onClick={() => void run(() => socialClient.acceptFriend(person.accountId), t("friendAdded", { name: person.displayName }))} />
          <IconButton size="sm" variant="outline" icon={X} label={t("declineAction")} title={t("declineAction")} disabled={busy}
            onClick={() => void run(() => socialClient.declineFriend(person.accountId))} />
        </>} />
      )} />
      <Section title={t("outgoingRequests")} people={inbox.outgoingRequests} render={person => (
        <PersonRow key={person.accountId} accountId={person.accountId} avatarVersion={person.avatarVersion} name={person.displayName} actions={
          <IconButton size="sm" variant="outline" icon={X} label={t("cancelRequest")} title={t("cancelRequest")} disabled={busy}
            onClick={() => void run(() => socialClient.cancelRequest(person.accountId))} />
        } />
      )} />
      {!inbox.friendRequests.length && !inbox.outgoingRequests.length &&
        <Typography variant="body2" tone="muted">{t("noRequests")}</Typography>}
    </Stack>
  );
};
