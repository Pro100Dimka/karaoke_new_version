import { useState, type FormEvent, type ReactNode } from "react";
import { Button, IconButton, Stack, TextField, Typography } from "@ad-voice/ui";
import { useNotify } from "../../app/NotificationsProvider";
import type { OnlineInbox, SocialPerson } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { socialClient } from "../../services/socialClient";
import { PersonRow } from "./PersonRow";
import { useSocialAction } from "./useSocialAction";

const Section = ({ title, people, render }: { title: string; people: SocialPerson[]; render(person: SocialPerson): ReactNode }) => (
  <section className="socialSection">
    <Typography variant="title">{title}</Typography>
    {people.length > 0 && <ul className="personList">{people.map(render)}</ul>}
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
    <Stack gap={4}>
      <section className="socialSection">
        <Typography variant="title">{t("myFriendCode")}</Typography>
        <Stack direction="row" gap={2} align="center">
          <Typography as="code" variant="mono" className="friendCode">{inbox.me.friendCode}</Typography>
          <IconButton size="sm" icon="copy" label={t("copyCode")} onClick={() => void copy()} />
        </Stack>
        <Typography variant="body-sm" tone="muted">{t("myFriendCodeHint")}</Typography>
      </section>
      <form className="friendCodeForm" onSubmit={event => void send(event)}>
        <TextField label={t("friendCodeField")} value={code} onValueChange={setCode} autoComplete="off" spellCheck={false} />
        <Button type="submit" variant="primary" icon="person" disabled={busy || !code.trim()}>{t("sendFriendRequest")}</Button>
      </form>
      <Section title={t("incomingRequests")} people={inbox.friendRequests} render={person => (
        <PersonRow key={person.accountId} accountId={person.accountId} avatarVersion={person.avatarVersion} name={person.displayName} actions={<>
          <IconButton size="sm" variant="primary" icon="check" label={t("acceptAction")} disabled={busy}
            onClick={() => void run(() => socialClient.acceptFriend(person.accountId), t("friendAdded", { name: person.displayName }))} />
          <IconButton size="sm" icon="close" label={t("declineAction")} disabled={busy}
            onClick={() => void run(() => socialClient.declineFriend(person.accountId))} />
        </>} />
      )} />
      <Section title={t("outgoingRequests")} people={inbox.outgoingRequests} render={person => (
        <PersonRow key={person.accountId} accountId={person.accountId} avatarVersion={person.avatarVersion} name={person.displayName} actions={
          <IconButton size="sm" icon="close" label={t("cancelRequest")} disabled={busy}
            onClick={() => void run(() => socialClient.cancelRequest(person.accountId))} />
        } />
      )} />
      {!inbox.friendRequests.length && !inbox.outgoingRequests.length &&
        <Typography variant="body-sm" tone="muted">{t("noRequests")}</Typography>}
    </Stack>
  );
};
