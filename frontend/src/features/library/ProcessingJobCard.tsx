import {
  Button,
  Card,
  IconButton,
  Menu,
  MessageBar,
  Stack,
  Steps,
  StatusIndicator,
  Typography,
  type MenuItemData,
} from "@neo-ui-kit/react";
import { useRef, useState } from "react";
import type { ProcessingJobDto, SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import {
  isActive,
  isRetryable,
  phaseOf,
  phases,
  processingDuration,
  processingTitle,
  stateLabel,
  stateTone,
} from "./processingModel";
import { errorMessageKey } from "../../shared/errors";

export interface JobActions {
  canMove(direction: -1 | 1): boolean;
  onMove(direction: -1 | 1): void;
  onOpenFolder(song: SongDto): void;
  onPlay(song: SongDto): void;
  playbackDisabled?: boolean;
  onRetry(song: SongDto): void;
  onResetLyrics?(song: SongDto): void;
  onStop(): void;
  onDetails(): void;
  onRemove(): void;
  motionPaused: boolean;
  onToggleMotion(): void;
}

const queueMoves = [
  { direction: -1, icon: "up", label: "processingMoveUp" },
  { direction: 1, icon: "down", label: "processingMoveDown" },
] as const;

/** One job of the queue: song, state, progress and phase, the actions its state allows, and a menu for the rest. */
export const ProcessingJobCard = ({
  job,
  song,
  index,
  actions,
}: {
  job: ProcessingJobDto;
  song?: SongDto;
  index: number;
  actions: JobActions;
}) => {
  const t = useText();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const active = isActive(job);
  const retryable = isRetryable(job);
  const duration = processingDuration(job);
  const phase = job.state === "completed" ? phases.length : phaseOf(job);
  const menu: MenuItemData[] = [
    {
      id: "details",
      label: t("processingJobDetails"),
      icon: "info",
      onSelect: actions.onDetails,
    },
    ...(song
      ? [
          {
            id: "folder",
            label: t("openFolder"),
            icon: "folder",
            onSelect: () => actions.onOpenFolder(song),
          },
        ]
      : []),
    {
      id: "motion",
      label: t(
        actions.motionPaused
          ? "processingResumeMotion"
          : "processingPauseMotion",
      ),
      icon: "motion",
      onSelect: actions.onToggleMotion,
    },
    { id: "separator", separator: true },
    {
      id: "remove",
      label: t("processingRemove"),
      icon: "trash",
      danger: true,
      onSelect: actions.onRemove,
    },
  ];

  return (
    <li>
      <Card
        border
        padding="sm"
        className="processingJob"
        data-state={job.state}
      >
        {song?.artworkUrl ? (
          <img className="processingCover" src={song.artworkUrl} alt="" />
        ) : (
          <span
            className="processingCover"
            data-tone={index % 4}
            aria-hidden="true"
          />
        )}
        <div className="processingJobMain">
          <Typography as="strong" variant="title" truncate>
            {processingTitle(job, song) ?? t("processingSongUnavailable")}
          </Typography>
          <Stack
            direction="row"
            gap="var(--ad-space-1) var(--ad-space-4)"
            align="center"
            wrap
          >
            <StatusIndicator
              status={stateTone[job.state]}
              label={t(stateLabel[job.state])}
            />
            {job.processingBackend && (
              <Typography variant="caption" tone="muted" title={t("processingVia")}>
                {t(job.processingBackend === "Kaggle" ? "processingBackendKaggle" : "processingBackendLocal")}
              </Typography>
            )}
            {duration && (
              <Typography
                variant="caption"
                tone="muted"
                title={t("processingDuration")}
              >{duration}</Typography>
            )}
          </Stack>
          <Steps className="processingSteps" steps={phases.map((step) => t(step))}
            current={phase ?? -1} aria-label={t("processingDetailsStage")} />
          {(job.state === "failed" || job.state === "interrupted") && (
            <MessageBar tone="error">
              {t(job.error && errorMessageKey(job.error) || "processingFailedHelp")}
            </MessageBar>
          )}
          {job.error?.code === "ManualLyricsConflict" && song && actions.onResetLyrics && (
            <Button size="sm" icon="reset" onClick={() => actions.onResetLyrics?.(song)}>
              {t("resetLyricsAndReprocess")}
            </Button>
          )}
        </div>
        <div className="processingJobActions">
          {job.state === "completed" && song && (
            <IconButton
              icon="play"
              label={t("play")}
              disabled={actions.playbackDisabled}
              onClick={() => actions.onPlay(song)}
            />
          )}
          {active && (
            <IconButton
              icon="stop"
              variant="danger"
              label={t("cancel")}
              onClick={actions.onStop}
            />
          )}
          {job.state === "queued" &&
            queueMoves.map(({ direction, icon, label }) => (
              <IconButton
                key={direction}
                icon={icon}
                label={t(label)}
                disabled={!actions.canMove(direction)}
                onClick={() => actions.onMove(direction)}
              />
            ))}
          {retryable && song && (
            <IconButton
              icon="reset"
              label={t("retry")}
              onClick={() => actions.onRetry(song)}
            />
          )}
          <IconButton
            ref={menuAnchor}
            variant="ghost"
            icon="more"
            label={t("processingJobActions")}
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
        </div>
      </Card>
    </li>
  );
};
