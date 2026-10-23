import { memo, useRef, useState } from "react";
import { Card, IconButton, Menu, Typography } from "@neo-ui-kit/react";
import type { SongDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { ProcessingSignal } from "./ProcessingSignal";
import { SongStatusBadge } from "./SongStatusBadge";
import { songStatusPresentation, type SongActionId } from "./songPresentation";

export type SongCardHandlers = Record<
  | "onPlay"
  | "onProcess"
  | "onCancel"
  | "onDetails"
  | "onSettings"
  | "onRecordings"
  | "onOpenFolder"
  | "onDelete"
  | "onViewError",
  (song: SongDto) => void
>;

const actionMeta = {
  play: { label: "play", icon: "play" },
  process: { label: "process", icon: "wave" },
  reprocess: { label: "reprocess", icon: "reset" },
  cancelQueued: { label: "cancelQueueItem", icon: "stop" },
  processingDetails: { label: "openProcessingDetails", icon: "processing" },
  recordings: { label: "recordings", icon: "headphones" },
  settings: { label: "songSettings", icon: "settings" },
  folder: { label: "openFolder", icon: "folder" },
  viewError: { label: "viewError", icon: "warning" },
  delete: { label: "deleteSong", icon: "trash" },
} as const satisfies Record<SongActionId, { label: MessageKey; icon: string }>;

const menuOrder = [
  "settings",
  "reprocess",
  "folder",
  "viewError",
  "delete",
] as const satisfies readonly SongActionId[];
const primaryActions = {
  play: "play",
  process: "process",
  cancel: "cancelQueued",
  details: "processingDetails",
  repair: "reprocess",
} as const satisfies Record<
  Exclude<
    (typeof songStatusPresentation)[keyof typeof songStatusPresentation]["primaryAction"],
    "none"
  >,
  SongActionId
>;

/** The primary button's icon: in a room a guest picks songs, otherwise it is the song's main action. */
const primaryIcon = (
  primary: SongActionId | null,
  roomSelection?: { role: string; selected: boolean },
) => {
  if (roomSelection && roomSelection.role !== "host")
    return roomSelection.selected ? "check" : "users";
  return primary ? actionMeta[primary].icon : "processing";
};

export const SongCard = memo(
  function SongCard({
    song,
    handlers,
    roomSelection,
  }: {
    song: SongDto;
    handlers: SongCardHandlers;
    roomSelection?: { role: string; selected: boolean };
  }) {
    const t = useText();
    const menuAnchor = useRef<HTMLButtonElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const presentation = songStatusPresentation[song.status];
    const allowed = new Set<SongActionId>(
      song.roomOwnerId ? ["play"] : presentation.actions,
    );
    const run = (id: SongActionId): void => {
      const map = {
        play: handlers.onPlay,
        process: handlers.onProcess,
        reprocess: handlers.onProcess,
        cancelQueued: handlers.onCancel,
        processingDetails: handlers.onDetails,
        recordings: handlers.onRecordings,
        settings: handlers.onSettings,
        folder: handlers.onOpenFolder,
        viewError: handlers.onViewError,
        delete: handlers.onDelete,
      } as const satisfies Record<SongActionId, (song: SongDto) => void>;
      map[id](song);
    };
    const primary: SongActionId | null =
      presentation.primaryAction === "none"
        ? null
        : primaryActions[presentation.primaryAction];
    const menuActions = menuOrder.filter((id) => allowed.has(id));

    return (
      <Card
        border
        padding="none"
        className="songCard"
        aria-label={`${song.artist} — ${song.title}`}
      >
        {song.artworkUrl && (
          <img className="songCardCover" src={song.artworkUrl} alt="" loading="lazy" />
        )}
        <div className="songCardContent">
          <header className="songCardHead">
            <div className="songCardTitle">
              <Typography as="h3" variant="h3" truncate>
                {song.title}
              </Typography>
              {song.artist && (
                <Typography as="h4" variant="body-sm" truncate>
                  {song.artist}
                </Typography>
              )}
            </div>
            <SongStatusBadge status={song.status} />
          </header>
          <div className="songCardActions">
            <IconButton
              round
              size="sm"
              variant="primary"
              icon={primaryIcon(primary, roomSelection)}
              label={t(presentation.primaryLabel)}
              disabled={presentation.primaryDisabled || primary === null}
              onClick={() => primary && run(primary)}
            />
            {allowed.has("recordings") && (
              <IconButton
                round
                size="sm"
                icon="headphones"
                label={t("recordings")}
                onClick={() => run("recordings")}
              />
            )}
            {menuActions.length > 0 && (
              <>
                <IconButton
                  ref={menuAnchor}
                  round
                  size="sm"
                  icon="more"
                  label={t("moreActions")}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                />
                <Menu
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  anchorRef={menuAnchor}
                  align="end"
                  items={menuActions.map((id) => ({
                    id,
                    label: t(actionMeta[id].label),
                    icon: actionMeta[id].icon,
                    danger: id === "delete",
                    onSelect: () => run(id),
                  }))}
                />
              </>
            )}
            {song.status === "processing" && (
              <ProcessingSignal progress={song.progress ?? 0} song={song} />
            )}
          </div>
        </div>
      </Card>
    );
  },
  (previous, next) =>
    previous.song === next.song &&
    previous.handlers === next.handlers &&
    previous.roomSelection?.role === next.roomSelection?.role &&
    previous.roomSelection?.selected === next.roomSelection?.selected,
);
