import {
  AudioWaveform,
  Check,
  Ellipsis,
  FileWarning,
  FolderOpen,
  Headphones,
  LoaderCircle,
  OctagonX,
  Play,
  RotateCcw,
  Settings2,
  Trash2,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { SongDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { ActionMenu } from "../../shared/ui/ActionMenu";
import { Card, IconButton, Typography } from "../../theme/ui";
import { ProcessingSignal } from "./ProcessingSignal";
import { SongCoverArt } from "./SongCoverArt";
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
  play: { label: "play", icon: Play },
  process: { label: "process", icon: AudioWaveform },
  reprocess: { label: "reprocess", icon: RotateCcw },
  cancelQueued: { label: "cancelQueueItem", icon: OctagonX },
  processingDetails: { label: "openProcessingDetails", icon: LoaderCircle },
  recordings: { label: "recordings", icon: Headphones },
  settings: { label: "songSettings", icon: Settings2 },
  folder: { label: "openFolder", icon: FolderOpen },
  viewError: { label: "viewError", icon: FileWarning },
  delete: { label: "deleteSong", icon: Trash2 },
} as const satisfies Record<
  SongActionId,
  { label: MessageKey; icon: LucideIcon }
>;

const menuOrder = [
  "settings",
  "reprocess",
  "folder",
  "viewError",
  "delete",
] as const satisfies readonly SongActionId[];

/** Stable per-song phase so neighbouring covers do not animate in lockstep. */
const coverPhase = (songId: string): number =>
  [...songId].reduce(
    (sum, character) => (sum * 31 + character.charCodeAt(0)) % 97,
    7,
  );

export const SongCard = ({
  song,
  handlers,
  roomSelection,
}: {
  song: SongDto;
  handlers: SongCardHandlers;
  roomSelection?: {
    role: string;
    selected: boolean;
  };
}) => {
  const t = useText();
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

  const primaryAction: SongActionId | null =
    presentation.primaryAction === "play"
      ? "play"
      : presentation.primaryAction === "process"
        ? "process"
        : presentation.primaryAction === "cancel"
          ? "cancelQueued"
          : presentation.primaryAction === "details"
            ? "processingDetails"
            : presentation.primaryAction === "repair"
              ? "reprocess"
              : null;
  const PrimaryIcon = primaryAction
    ? actionMeta[primaryAction].icon
    : LoaderCircle;
  const menuActions = menuOrder.filter((id) => allowed.has(id));
  const showProgress = song.status === "processing";

  return (
    <Card
      className="songCard"
      aria-label={`${song.artist} — ${song.title}`}
      tilt={false}
      variant="laser"
    >
      <div
        className={`songCardDetails${song.artworkUrl ? " songCardDetails--artwork" : ""}`}
      >
        {song.artworkUrl && (
          <div className="songCardArtworkLayer">
            <img
              className="songCardArtwork"
              src={song.artworkUrl}
              alt=""
              loading="lazy"
            />
            <div className="songCardArtworkShade" aria-hidden />
          </div>
        )}
        <div className="songCardEqualizer">
          <SongCoverArt cardIndex={coverPhase(song.id)} variant="overlay" />
        </div>
        <div className="songCardContent">
          <div className="songCardMeta">
            <div className="songCardIdentity">
              <Typography variant="body1" className="songTitle">
                {song.title}
              </Typography>
              <Typography variant="body2" tone="muted">
                {song.artist}
              </Typography>
            </div>
            <SongStatusBadge status={song.status} />
          </div>
          <div className="cardFooter">
            {showProgress && (
              <ProcessingSignal
                progress={song.progress ?? 0}
                stage={song.stage}
              />
            )}
            <IconButton
              icon={
                roomSelection && roomSelection.role !== "host"
                  ? roomSelection.selected
                    ? Check
                    : UsersRound
                  : PrimaryIcon
              }
              size="md"
              label={t(presentation.primaryLabel)}
              disabled={presentation.primaryDisabled || primaryAction === null}
              onClick={() => primaryAction && run(primaryAction)}
            />
            {allowed.has("recordings") && (
              <IconButton
                icon={Headphones}
                size="md"
                variant="outline"
                label={t("recordings")}
                onClick={() => run("recordings")}
              />
            )}
            {menuActions.length > 0 && (
              <ActionMenu
                iconOnly
                trigger={(triggerProps) => (
                  <IconButton
                    {...triggerProps}
                    icon={Ellipsis}
                    size="md"
                    variant="outline"
                    label={t("moreActions")}
                  />
                )}
                items={menuActions.map((id) => {
                  const { label, icon: Icon } = actionMeta[id];
                  return {
                    id,
                    label: t(label),
                    icon: <Icon size={16} />,
                    destructive: id === "delete",
                    run: () => run(id),
                  };
                })}
              />
            )}
          </div>
        </div>
      </div>
    </Card>
  );
};
