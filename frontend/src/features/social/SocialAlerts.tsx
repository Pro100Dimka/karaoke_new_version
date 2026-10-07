import { useEffect, useState, type ReactNode } from "react";
import { Button, Card, Stack, Typography } from "@ad-voice/ui";
import { useApp } from "../../app/AppContext";
import { useFriendRelations, useRoomInvitations } from "../../app/SocialProvider";
import type {
  OnlineInbox,
  SocialInbox,
  SocialInvite,
  SocialPerson,
} from "../../contracts/social";
import { useText } from "../../i18n/useText";
import { PersonAvatar } from "./PersonAvatar";
import { useSocialAction } from "./useSocialAction";

const Alert = ({
  person,
  text,
  actions,
}: {
  person: SocialPerson;
  text: string;
  actions: ReactNode;
}) => (
  <Card
    border
    padding="sm"
    className="socialAlert"
    role="alertdialog"
    aria-label={text}
  >
    <Stack direction="row" gap={3} align="center">
      <PersonAvatar
        accountId={person.accountId}
        avatarVersion={person.avatarVersion}
        name={person.displayName}
      />
      <Typography>{text}</Typography>
    </Stack>
    <div className="socialAlertActions">{actions}</div>
  </Card>
);

/**
 * Friend requests and room invitations waiting for an answer, in a corner of every screen. A
 * request put off with "Later" stays in the Friends window; an invitation expires with its room.
 */
const OnlineSocialAlerts = ({ inbox }: { inbox: OnlineInbox }) => {
  const t = useText();
  const { room, preferences } = useApp();
  const invitations = useRoomInvitations();
  const friends = useFriendRelations();
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const { busy, run } = useSocialAction();
  const acceptInvite = (invite: SocialInvite) =>
    run(() => invitations.accept(invite.inviteId,
      preferences.displayName || inbox.me.displayName));
  useEffect(() => {
    invitations.prune(inbox.invites.map((invite) => invite.inviteId));
    const approved = inbox.invites.find(
      (invite) =>
        invitations.isRequestedRoom(invite.roomId) &&
        !invitations.isHandled(invite.inviteId),
    );
    if (!approved) return;
    void acceptInvite(approved);
  }, [inbox.invites, invitations]);
  const requests = inbox.friendRequests.filter(
    (person) => !later.has(person.accountId),
  );
  const roomRequests = inbox.notices.filter(
    (notice) => notice.kind === "JoinRequested" && notice.roomId === room?.code,
  );
  const invites = inbox.invites.filter(
    (invite) => !invitations.isRequestedRoom(invite.roomId),
  );

  return (
    <div className="socialAlerts" aria-live="polite">
      {invites.map((invite) => (
        <Alert
          key={invite.inviteId}
          person={invite.sender}
          text={t("roomInviteAlert", { name: invite.sender.displayName })}
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                disabled={busy}
                onClick={() => void acceptInvite(invite)}
              >
                {t("acceptAction")}
              </Button>
              <Button
                size="sm"
                icon="close"
                disabled={busy}
                onClick={() =>
                  void run(() => invitations.decline(invite.inviteId))
                }
              >
                {t("declineAction")}
              </Button>
            </>
          }
        />
      ))}
      {roomRequests.map((request) => (
        <Alert
          key={`join:${request.person.accountId}:${request.roomId}`}
          person={request.person}
          text={t("joinRequested", { name: request.person.displayName })}
          actions={
            <Button
              size="sm"
              variant="primary"
              icon="check"
              disabled={busy || !request.roomId}
              onClick={() => {
                const roomId = request.roomId;
                if (roomId)
                  void run(() =>
                    invitations.approve(
                      request.person.accountId,
                      roomId,
                    ),
                  );
              }}
            >
              {t("acceptAction")}
            </Button>
          }
        />
      ))}
      {requests.map((person) => (
        <Alert
          key={person.accountId}
          person={person}
          text={t("friendRequestAlert", { name: person.displayName })}
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                disabled={busy}
                onClick={() =>
                  void run(() => friends.accept(person.accountId))
                }
              >
                {t("acceptAction")}
              </Button>
              <Button
                size="sm"
                icon="close"
                disabled={busy}
                onClick={() =>
                  void run(() => friends.decline(person.accountId))
                }
              >
                {t("declineAction")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="clock"
                disabled={busy}
                onClick={() =>
                  setLater((current) => new Set(current).add(person.accountId))
                }
              >
                {t("laterAction")}
              </Button>
            </>
          }
        />
      ))}
    </div>
  );
};

export const SocialAlerts = ({ inbox }: { inbox: SocialInbox }) =>
  inbox.type === "inbox" ? <OnlineSocialAlerts inbox={inbox} /> : null;
