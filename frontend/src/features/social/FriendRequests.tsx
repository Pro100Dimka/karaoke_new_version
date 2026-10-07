import { useState, type FormEvent, type ReactNode } from "react";
import { Button, IconButton, Stack, TextField, Typography } from "@ad-voice/ui";
import { useNotify } from "../../app/NotificationsProvider";
import { useFriendRelations } from "../../app/SocialProvider";
import type { OnlineInbox, SocialPerson } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { PersonRow } from "./PersonRow";
import { useSocialAction } from "./useSocialAction";

const Section = ({
  title,
  people,
  actions,
}: {
  title: string;
  people: SocialPerson[];
  actions(person: SocialPerson): ReactNode;
}) => (
  <section className="socialSection">
    <Typography variant="title">{title}</Typography>
    {people.length > 0 && (
      <ul className="personList">
        {people.map((person) => (
          <PersonRow
            key={person.accountId}
            accountId={person.accountId}
            avatarVersion={person.avatarVersion}
            name={person.displayName}
            actions={actions(person)}
          />
        ))}
      </ul>
    )}
  </section>
);

/** My friend code to share, a friend request by someone else's code, and requests both ways. */
export const FriendRequests = ({ inbox }: { inbox: OnlineInbox }) => {
  const t = useText();
  const notify = useNotify();
  const { busy, run } = useSocialAction();
  const friends = useFriendRelations();
  const [code, setCode] = useState("");

  const send = async (event: FormEvent) => {
    event.preventDefault();
    let name = "";
    const sent = await run(async () => {
      name = (await friends.requestByCode(code)).person
        .displayName;
    });
    if (!sent) return;
    setCode("");
    notify(t("friendRequestSent", { name }), "success");
  };
  const copy = async () => {
    try {
      await friends.copyCode(inbox.me.friendCode);
      notify(t("codeCopied"), "success");
    } catch {
      notify(t("unavailable"), "error");
    }
  };

  return (
    <Stack gap={4}>
      <section className="socialSection">
        <Typography variant="title">{t("myFriendCode")}</Typography>
        <Stack direction="row" gap={2} align="center">
          <Typography as="code" variant="mono" className="friendCode">
            {inbox.me.friendCode}
          </Typography>
          <IconButton
            size="sm"
            icon="copy"
            label={t("copyCode")}
            onClick={() => void copy()}
          />
        </Stack>
        <Typography variant="body-sm" tone="muted">
          {t("myFriendCodeHint")}
        </Typography>
      </section>
      <form className="friendCodeForm" onSubmit={(event) => void send(event)}>
        <TextField
          label={t("friendCodeField")}
          value={code}
          onValueChange={setCode}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="submit"
          variant="primary"
          icon="person"
          disabled={busy || !code.trim()}
        >
          {t("sendFriendRequest")}
        </Button>
      </form>
      <Section
        title={t("incomingRequests")}
        people={inbox.friendRequests}
        actions={(person) => (
          <>
            <IconButton
              size="sm"
              variant="primary"
              icon="check"
              label={t("acceptAction")}
              disabled={busy}
              onClick={() =>
                void run(
                  () => friends.accept(person.accountId),
                  t("friendAdded", { name: person.displayName }),
                )
              }
            />
            <IconButton
              size="sm"
              icon="close"
              label={t("declineAction")}
              disabled={busy}
              onClick={() =>
                void run(() => friends.decline(person.accountId))
              }
            />
          </>
        )}
      />
      <Section
        title={t("outgoingRequests")}
        people={inbox.outgoingRequests}
        actions={(person) => (
          <IconButton
            size="sm"
            icon="close"
            label={t("cancelRequest")}
            disabled={busy}
            onClick={() =>
              void run(() => friends.cancel(person.accountId))
            }
          />
        )}
      />
      {!inbox.friendRequests.length && !inbox.outgoingRequests.length && (
        <Typography variant="body-sm" tone="muted">
          {t("noRequests")}
        </Typography>
      )}
    </Stack>
  );
};
