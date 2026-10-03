import { Check, Clock, Send, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useApp } from "../../app/AppContext";
import type { SocialInbox, SocialInvite, SocialPerson } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { socialClient } from "../../services/socialClient";
import { Button, Card, Stack, Typography } from "../../theme/ui";
import { enterRoom, leaveRoom } from "../room/enterRoom";
import { PersonAvatar } from "./PersonAvatar";
import { useSocialAction } from "./useSocialAction";

const Alert = ({ person, text, actions }: { person: SocialPerson; text: string; actions: ReactNode }) => (
  <Card variant="neon" tilt={false} className="socialAlert" role="alertdialog" aria-label={text}>
    <Stack direction="row" align="center" gap="var(--space-3)">
      <PersonAvatar accountId={person.accountId} avatarVersion={person.avatarVersion} name={person.displayName} />
      <Typography variant="body1">{text}</Typography>
    </Stack>
    <Stack direction="row" gap="var(--space-2)" className="socialAlertActions">{actions}</Stack>
  </Card>
);

/**
 * Friend requests and room invitations waiting for an answer, in a corner of every screen. A
 * request put off with "Later" stays in the Friends window; an invitation expires with its room.
 */
export const SocialAlerts = ({ inbox }: { inbox: SocialInbox }) => {
  const t = useText();
  const { room, setRoom, preferences } = useApp();
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const { busy, run } = useSocialAction();
  if (inbox.type !== "inbox") return null;

  const acceptInvite = (invite: SocialInvite) => run(async () => {
    const { roomId } = await socialClient.acceptInvite(invite.inviteId);
    if (room) await leaveRoom(room.code);
    setRoom(await enterRoom(preferences.displayName || inbox.me.displayName, roomId));
  });
  const requests = inbox.friendRequests.filter(person => !later.has(person.accountId));
  const roomRequests = inbox.notices.filter(notice =>
    notice.kind === "JoinRequested" && notice.roomId === room?.code);

  return (
    <div className="socialAlerts" aria-live="polite">
      {inbox.invites.map(invite => (
        <Alert key={invite.inviteId} person={invite.sender} text={t("roomInviteAlert", { name: invite.sender.displayName })} actions={<>
          <Button size="sm" disabled={busy} startIcon={<Check size={16} />} onClick={() => void acceptInvite(invite)}>{t("acceptAction")}</Button>
          <Button size="sm" variant="outlined" disabled={busy} startIcon={<X size={16} />} onClick={() => void run(() => socialClient.declineInvite(invite.inviteId))}>{t("declineAction")}</Button>
        </>} />
      ))}
      {roomRequests.map(request => (
        <Alert
          key={`join:${request.person.accountId}:${request.roomId}`}
          person={request.person}
          text={t("joinRequested", { name: request.person.displayName })}
          actions={
            <Button
              size="sm"
              disabled={busy}
              startIcon={<Send size={16} />}
              onClick={() => void run(
                () => socialClient.invite(request.person.accountId, request.roomId!),
                t("inviteSent", { name: request.person.displayName }),
              )}
            >
              {t("inviteToRoom")}
            </Button>
          }
        />
      ))}
      {requests.map(person => (
        <Alert key={person.accountId} person={person} text={t("friendRequestAlert", { name: person.displayName })} actions={<>
          <Button size="sm" disabled={busy} startIcon={<Check size={16} />} onClick={() => void run(() => socialClient.acceptFriend(person.accountId))}>{t("acceptAction")}</Button>
          <Button size="sm" variant="outlined" disabled={busy} startIcon={<X size={16} />} onClick={() => void run(() => socialClient.declineFriend(person.accountId))}>{t("declineAction")}</Button>
          <Button size="sm" variant="outlined" tone="neutral" disabled={busy} startIcon={<Clock size={16} />} onClick={() => setLater(current => new Set(current).add(person.accountId))}>{t("laterAction")}</Button>
        </>} />
      ))}
    </div>
  );
};
