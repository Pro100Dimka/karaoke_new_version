import { useRef, useState } from "react";
import { Card, IconButton, Menu, MessageBar, ProgressBar, StatusIndicator, Steps, Typography, type MenuItemData } from "@ad-voice/ui";
import type { ProcessingJobDto, SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { isActive, isRetryable, phaseOf, phases, processingDuration, stateLabel, stateTone } from "./processingModel";

export interface JobActions {
  canMove(direction: -1 | 1): boolean;
  onMove(direction: -1 | 1): void;
  onOpenFolder(song: SongDto): void;
  onPlay(song: SongDto): void;
  onRetry(song: SongDto): void;
  onStop(): void;
  onDetails(): void;
  onRemove(): void;
  motionPaused: boolean;
  onToggleMotion(): void;
}

/** One job of the queue: song, state, progress and phase, the actions its state allows, and a menu for the rest. */
export const ProcessingJobCard = ({ job, song, index, actions }: {
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
  const phase = phaseOf(job);
  const menu: MenuItemData[] = [
    { id: "details", label: t("processingJobDetails"), icon: "info", onSelect: actions.onDetails },
    ...(retryable && song ? [{ id: "retry", label: t("retry"), icon: "reset", onSelect: () => actions.onRetry(song) }] : []),
    ...(active ? [{ id: "stop", label: t("processingStop"), icon: "stop", onSelect: actions.onStop }] : []),
    { id: "motion", label: t(actions.motionPaused ? "processingResumeMotion" : "processingPauseMotion"), icon: "motion", onSelect: actions.onToggleMotion },
    { id: "separator", separator: true },
    { id: "remove", label: t("processingRemove"), icon: "trash", danger: true, onSelect: actions.onRemove },
  ];

  return (
    <li>
      <Card border padding="sm" className="processingJob" data-state={job.state}>
        {song?.artworkUrl
          ? <img className="processingCover" src={song.artworkUrl} alt="" />
          : <span className="processingCover" data-tone={index % 4} aria-hidden="true" />}
        <div className="processingJobMain">
          <Typography as="strong" variant="title" truncate>{song ? `${song.artist} — ${song.title}` : job.songId}</Typography>
          <div className="processingJobMeta">
            <StatusIndicator status={stateTone[job.state]} label={t(stateLabel[job.state])} />
            <Typography variant="caption" tone="muted">
              {job.processingBackend
                ? `${t("processingVia")}: ${t(job.processingBackend === "Kaggle" ? "processingBackendKaggle" : "processingBackendLocal")}`
                : job.stage}
            </Typography>
            {duration && <Typography variant="caption" tone="muted">{`${t("processingDuration")}: ${duration}`}</Typography>}
          </div>
          <div className="processingJobProgress">
            <ProgressBar label={t("processingDetailsProgress")} value={job.progress} />
            <Typography variant="caption" weight="semibold">{job.progress}%</Typography>
          </div>
          {active && phase !== undefined && <Steps className="processingPhases" steps={phases.map(key => t(key))} current={phase} />}
          {retryable && <MessageBar tone="error">{job.error?.message ?? t(stateLabel[job.state])}</MessageBar>}
        </div>
        <div className="processingJobTools">
          {job.state === "completed" && song && <>
            <IconButton icon="folder" label={t("openFolder")} onClick={() => actions.onOpenFolder(song)} />
            <IconButton icon="play" label={t("play")} onClick={() => actions.onPlay(song)} />
          </>}
          {active && <IconButton icon="stop" variant="danger" label={t("cancel")} onClick={actions.onStop} />}
          {job.state === "queued" && <>
            <IconButton icon="up" label={t("processingMoveUp")} disabled={!actions.canMove(-1)} onClick={() => actions.onMove(-1)} />
            <IconButton icon="down" label={t("processingMoveDown")} disabled={!actions.canMove(1)} onClick={() => actions.onMove(1)} />
          </>}
          {retryable && song && <IconButton icon="reset" label={t("retry")} onClick={() => actions.onRetry(song)} />}
          <IconButton ref={menuAnchor} variant="ghost" icon="more" label={t("processingJobActions")} aria-haspopup="menu"
            aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)} />
          <Menu open={menuOpen} onOpenChange={setMenuOpen} anchorRef={menuAnchor} align="end" items={menu} />
        </div>
      </Card>
    </li>
  );
};
