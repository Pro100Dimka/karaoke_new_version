import { Card, IconButton, Menu, MessageBar, Stack, Steps, StatusIndicator, Typography, type MenuItemData, tr, useLocale } from "@neo-ui-kit/react";
import { useRef, useState } from "react";
import type { ProcessingJobDto, SongDto } from "../../../../contracts/models";
import { ru } from "../../../../i18n/messages.ru";
import {
  isActive,
  phaseOf,
  phases,
  processingDuration,
  processingTitle,
  stateLabel,
  stateTone,
} from "./processingModel";
import { errorMessageKey } from "../../../../shared/errors";

export interface JobActions {
  onOpenFolder(song: SongDto): void;
  onPlay(song: SongDto): void;
  playbackDisabled?: boolean;
  onStop(): void;
  onDetails(): void;
  onRemove(): void;
  motionPaused: boolean;
  onToggleMotion(): void;
}

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
  useLocale();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const active = isActive(job);
  const duration = processingDuration(job);
  const phase = job.state === "completed" ? phases.length : phaseOf(job);
  const menu: MenuItemData[] = [
    {
      id: "details",
      label: tr(ru.processingJobDetails),
      icon: "info",
      onSelect: actions.onDetails,
    },
    ...(song
      ? [
          {
            id: "folder",
            label: tr(ru.openFolder),
            icon: "folder",
            onSelect: () => actions.onOpenFolder(song),
          },
        ]
      : []),
    {
      id: "motion",
      label: tr(
        ru[actions.motionPaused
          ? "processingResumeMotion"
          : "processingPauseMotion"],
      ),
      icon: "motion",
      onSelect: actions.onToggleMotion,
    },
    { id: "separator", separator: true },
    {
      id: "remove",
      label: tr(ru.processingRemove),
      icon: "trash",
      danger: true,
      onSelect: actions.onRemove,
    },
  ];

  return (
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
            {processingTitle(job, song) ?? tr(ru.processingSongUnavailable)}
          </Typography>
          <Stack
            direction="row"
            gap="var(--ad-space-1) var(--ad-space-4)"
            align="center"
            wrap
          >
            <StatusIndicator
              status={stateTone[job.state]}
              label={tr(ru[stateLabel[job.state]])}
            />
            {job.processingBackend && (
              <Typography
                variant="caption"
                tone="muted"
                title={tr(ru.processingVia)}
              >
                {tr(
                  ru[job.processingBackend === "Kaggle"
                    ? "processingBackendKaggle"
                    : "processingBackendLocal"],
                )}
              </Typography>
            )}
            {duration && (
              <Typography
                variant="caption"
                tone="muted"
                title={tr(ru.processingDuration)}
              >
                {duration}
              </Typography>
            )}
          </Stack>
          <Steps
            className="processingSteps"
            steps={phases.map((step) => tr(ru[step]))}
            current={phase ?? -1}
            aria-label={tr(ru.processingDetailsStage)}
          />
          {(job.state === "failed" || job.state === "interrupted") && (
            <MessageBar tone="error">
              {tr(
                ru[(job.error && errorMessageKey(job.error)) ||
                  "processingFailedHelp"],
              )}
            </MessageBar>
          )}
        </div>
        <div className="processingJobActions">
          {job.state === "completed" && song && (
            <IconButton
              icon="play"
              label={tr(ru.play)}
              disabled={actions.playbackDisabled}
              onClick={() => actions.onPlay(song)}
            />
          )}
          {active && (
            <IconButton
              icon="stop"
              variant="danger"
              label={tr(ru.cancel)}
              onClick={actions.onStop}
            />
          )}
          <IconButton
            ref={menuAnchor}
            variant="ghost"
            icon="more"
            label={tr(ru.processingJobActions)}
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
  );
};
