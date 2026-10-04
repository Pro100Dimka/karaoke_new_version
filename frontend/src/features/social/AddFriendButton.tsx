import { IconButton } from "@ad-voice/ui";
import type { SocialPerson } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { socialClient } from "../../services/socialClient";
import { useSocialAction } from "./useSocialAction";

/** Adds someone met in a room as a friend (or accepts their request); nothing for a friend. */
export const AddFriendButton = ({ person }: { person: SocialPerson | undefined }) => {
  const t = useText();
  const { busy, run } = useSocialAction();
  if (!person || person.relation === "Self" || person.relation === "Friend") return null;
  if (person.relation === "Requested")
    return <IconButton size="xs" icon="check" label={t("requestPending")} disabled />;
  const incoming = person.relation === "Incoming";
  return (
    <IconButton size="xs" icon="person" label={incoming ? t("acceptAction") : t("addFriend")} disabled={busy}
      onClick={() => void run(
        () => incoming ? socialClient.acceptFriend(person.accountId) : socialClient.requestFriend({ accountId: person.accountId }),
        t(incoming ? "friendAdded" : "friendRequestSent", { name: person.displayName }),
      )} />
  );
};
