import {
  Button,
  Card,
  Icon,
  IconButton,
  Menu,
  ProgressBar,
  Stack,
  Typography,
  type MenuItemData,
} from "@ad-voice/ui";
import { useRef, useState } from "react";
import type { RoomStateDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { useTransferEta } from "./useTransferEta";

// The code is shown as its first four groups; copying gives all of it.
const shownCode = (code: string): string =>
  code.split("-").slice(0, 4).join("-");

export interface RoomHeadActions {
  copied: boolean;
  checkingSync: boolean;
  detached: boolean;
  onCopy(): void;
  onCollapse(): void;
  onCheckSync(): void;
  onDetach(): void;
  onAttach(): void;
  onCancelTransfer(): void;
  onRetryTransfer(): void;
  onReplaceProject(): void;
  onLeave(): void;
}

/** What the transfer needs from the singer: wait for reconnection, retry, replace their copy, or just wait a few minutes. */
const TransferNote = ({
  room,
  actions,
}: {
  room: RoomStateDto;
  actions: RoomHeadActions;
}) => {
  const t = useText();
  const minutes = useTransferEta(
    room.transferId ?? room.songId,
    room.transferProgress,
  );
  if (room.connectionStatus === "reconnecting")
    return (
      <Typography
        role="status"
        aria-label={t("roomReconnecting")}
        variant="caption"
        tone="warning"
        className="roomHeadNote"
      >
        <Icon name="signal" />
        {t("roomReconnecting")}
      </Typography>
    );
  if (room.transferError) {
    const conflict = room.transferConflict === true;
    return (
      <div className="roomHeadNote">
        {conflict && (
          <Typography variant="caption" tone="warning">
            {t("roomProjectConflict")}
          </Typography>
        )}
        <Button
          size="xs"
          icon={conflict ? "migrate" : "refresh"}
          onClick={
            conflict ? actions.onReplaceProject : actions.onRetryTransfer
          }
        >
          {t(conflict ? "roomReplaceProject" : "retryTransfer")}
        </Button>
      </div>
    );
  }
  if (
    room.transferProgress === undefined ||
    room.transferProgress >= 100 ||
    minutes === undefined
  )
    return null;
  return (
    <Typography variant="caption" tone="muted">
      {minutes <= 1
        ? t("transferRemainingSoon")
        : t("transferRemaining", { minutes })}
    </Typography>
  );
};

/** The room: the selected song's picture, the code to share, what it is busy with, and its actions. */
export const RoomHeadCard = ({
  room,
  artwork,
  actions,
}: {
  room: RoomStateDto;
  artwork?: { title: string; url: string };
  actions: RoomHeadActions;
}) => {
  const t = useText();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const progress = room.transferError ? undefined : room.transferProgress;
  const transferring = progress !== undefined && progress < 100;
  const song = room.sharedSongs?.find(
    (item) => item.songId === room.songId,
  )?.title;
  console.log(song);
  const menu: MenuItemData[] = [
    ...(actions.detached
      ? []
      : [
          {
            id: "collapse",
            label: t("collapseRoom"),
            icon: "back",
            onSelect: actions.onCollapse,
          },
        ]),
    {
      id: "sync",
      label: t("roomCheckSync"),
      icon: "signal",
      disabled: actions.checkingSync,
      onSelect: actions.onCheckSync,
    },
    ...(room.transferId && !room.transferError
      ? [
          {
            id: "cancel",
            label: t("cancelTransfer"),
            icon: "close",
            onSelect: actions.onCancelTransfer,
          },
        ]
      : []),
    actions.detached
      ? {
          id: "attach",
          label: t("panelAttach"),
          icon: "window",
          onSelect: actions.onAttach,
        }
      : {
          id: "detach",
          label: t("roomDetach"),
          icon: "window",
          onSelect: actions.onDetach,
        },
  ];

  return (
    <Card
      border
      padding="sm"
      className="roomHead"
      data-art={artwork ? "" : undefined}
      aria-label={t("onlineRoom")}
    >
      {artwork && (
        <img className="roomArt" src={artwork.url} alt={artwork.title} />
      )}
      <div className="roomHeadBody">
        <div className="roomCodeRow">
          <Typography as="strong" variant="title" truncate title={room.code}>
            {shownCode(room.code)}
          </Typography>
          <IconButton
            size="xs"
            variant="ghost"
            icon={actions.copied ? "check" : "copy"}
            label={t(actions.copied ? "copied" : "copyCode")}
            onClick={actions.onCopy}
          />
        </div>
        {transferring || room.transferError ? (
          <Typography variant="caption" tone="muted" truncate>
            {t("transferLabel")}
          </Typography>
        ) : null}
        {transferring && (
          <div className="roomProgressRow">
            <ProgressBar
              label={t("projectTransfer", { progress })}
              value={progress}
            />
            <Typography variant="caption" weight="semibold">
              {progress}%
            </Typography>
          </div>
        )}
        <TransferNote room={room} actions={actions} />
      </div>
      <Stack gap={1} direction="row" align="center" className="roomHeadActions">
        <IconButton
          ref={menuAnchor}
          size="sm"
          variant="ghost"
          icon="more"
          label={t("roomActions")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        />
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          anchorRef={menuAnchor}
          align="end"
          items={menu}
        />
        <IconButton
          size="sm"
          variant="ghost"
          icon="leave"
          label={t("leaveRoom")}
          onClick={actions.onLeave}
        />
      </Stack>
    </Card>
  );
};
