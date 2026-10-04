import { useState, type ReactNode } from "react";
import { Button, Card, Typography } from "@ad-voice/ui";
import { useApp } from "../../app/AppContext";
import type { SocialInbox, SocialInvite, SocialPerson } from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { socialClient } from "../../services/socialClient";
import { enterRoom, leaveRoom } from "../room/enterRoom";
import { PersonAvatar } from "./PersonAvatar";
import { useSocialAction } from "./useSocialAction";

const Alert = ({ person, text, actions }: { person: SocialPerson; text: string; actions: ReactNode }) => (
  <Card border padding="sm" className="socialAlert" role="alertdialog" aria-label={text}>
    <div className="socialAlertHead">
      <PersonAvatar accountId={person.accountId} avatarVersion={person.avatarVersion} name={person.displayName} />
      <Typography>{text}</Typography>
    </div>
    <div className="socialAlertActions">{actions}</div>
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
  const roomRequests = inbox.notices.filter(notice => notice.kind === "JoinRequested" && notice.roomId === room?.code);

  return (
    <div className="socialAlerts" aria-live="polite">
      {inbox.invites.map(invite => (
        <Alert key={invite.inviteId} person={invite.sender} text={t("roomInviteAlert", { name: invite.sender.displayName })} actions={<>
          <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => void acceptInvite(invite)}>{t("acceptAction")}</Button>
          <Button size="sm" icon="close" disabled={busy} onClick={() => void run(() => socialClient.declineInvite(invite.inviteId))}>{t("declineAction")}</Button>
        </>} />
      ))}
      {roomRequests.map(request => (
        <Alert key={`join:${request.person.accountId}:${request.roomId}`} person={request.person}
          text={t("joinRequested", { name: request.person.displayName })} actions={
            <Button size="sm" variant="primary" icon="users" disabled={busy || !request.roomId} onClick={() => {
              const roomId = request.roomId;
              if (roomId) void run(() => socialClient.invite(request.person.accountId, roomId), t("inviteSent", { name: request.person.displayName }));
            }}>
              {t("inviteToRoom")}
            </Button>
          } />
      ))}
      {requests.map(person => (
        <Alert key={person.accountId} person={person} text={t("friendRequestAlert", { name: person.displayName })} actions={<>
          <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => void run(() => socialClient.acceptFriend(person.accountId))}>{t("acceptAction")}</Button>
          <Button size="sm" icon="close" disabled={busy} onClick={() => void run(() => socialClient.declineFriend(person.accountId))}>{t("declineAction")}</Button>
          <Button size="sm" variant="ghost" icon="clock" disabled={busy} onClick={() => setLater(current => new Set(current).add(person.accountId))}>{t("laterAction")}</Button>
        </>} />
      ))}
    </div>
  );
};
