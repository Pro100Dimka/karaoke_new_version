import {
  Card,
  Button,
  IconButton,
  Menu,
  MessageBar,
  Stack,
  StatusIndicator,
  Steps,
  tr,
  Typography,
  useLocale,
  type MenuItemData,
} from '@neo-ui-kit/react';
import { useRef, useState } from 'react';
import type { ProcessingJobDto, SongDto } from '../../../../contracts/models';
import { processingErrorText } from './ProcessingError';
import {
  isActive,
  phaseOf,
  phases,
  processingDuration,
  processingTitle,
  stateLabel,
  stateTone,
} from './processingModel';

interface JobActions {
  onOpenFolder(song: SongDto): void;
  onPlay(song: SongDto): void;
  playbackDisabled?: boolean;
  onStop(): void;
  onDetails(): void;
  onRemove(): void;
  onReport(): void;
  onRetry(): void;
  reporting: boolean;
  retrying: boolean;
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
  const phase =
    song?.status === 'importing'
      ? 0
      : job.state === 'completed'
        ? phases.length
        : phaseOf(job);
  const menu: MenuItemData[] = [
    {
      id: 'details',
      label: tr('processingJobDetails'),
      icon: 'info',
      onSelect: actions.onDetails,
    },
    ...(song && song.status !== 'importing'
      ? [
          {
            id: 'folder',
            label: tr('openFolder'),
            icon: 'folder',
            onSelect: () => actions.onOpenFolder(song),
          },
        ]
      : []),
    {
      id: 'motion',
      label: tr(
        actions.motionPaused
          ? 'processingResumeMotion'
          : 'processingPauseMotion',
      ),
      icon: 'motion',
      onSelect: actions.onToggleMotion,
    },
    { id: 'separator', separator: true },
    {
      id: 'remove',
      label: tr('processingRemove'),
      icon: 'trash',
      danger: true,
      onSelect: actions.onRemove,
    },
  ];

  return (
    <Card border padding="sm" className="processingJob" data-state={job.state}>
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
          {processingTitle(job, song) ?? tr('processingSongUnavailable')}
        </Typography>
        <Stack
          direction="row"
          gap="var(--ad-space-1) var(--ad-space-4)"
          align="center"
          wrap
        >
          <StatusIndicator
            status={stateTone[job.state]}
            label={tr(
              song?.status === 'importing'
                ? 'importing'
                : stateLabel[job.state],
            )}
          />
          {job.processingBackend && (
            <Typography
              variant="caption"
              tone="muted"
              title={tr('processingVia')}
            >
              {tr(
                {
                  Local: 'processingBackendLocal',
                  Kaggle: 'processingBackendKaggle',
                  Oracle: 'processingBackendOracle',
                }[job.processingBackend],
              )}
            </Typography>
          )}
          {duration && (
            <Typography
              variant="caption"
              tone="muted"
              title={tr('processingDuration')}
            >
              {duration}
            </Typography>
          )}
        </Stack>
        <Steps
          className="processingSteps"
          steps={phases.map((step) => tr(step))}
          current={phase ?? -1}
          aria-label={tr('processingDetailsStage')}
        />
        {['failed', 'interrupted'].includes(job.state) && (
          <>
            <MessageBar
              tone="error"
              style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            >
              {processingErrorText(job)}
            </MessageBar>
            <Stack direction="row" gap={2} wrap>
              <Button
                size="sm"
                icon="warning"
                variant="ghost"
                onClick={actions.onDetails}
              >
                {tr('viewError')}
              </Button>
              <Button
                size="sm"
                icon="upload"
                disabled={actions.reporting}
                onClick={actions.onReport}
              >
                {tr(
                  actions.reporting
                    ? 'processingReportSending'
                    : 'processingSendReport',
                )}
              </Button>
            </Stack>
          </>
        )}
      </div>
      <div className="processingJobActions">
        {['failed', 'interrupted'].includes(job.state) &&
          song &&
          !['queued', 'processing', 'importing'].includes(song.status) && (
            <IconButton
              icon="refresh"
              label={tr('processingRetry')}
              disabled={actions.retrying}
              onClick={actions.onRetry}
            />
          )}
        {job.state === 'completed' && song && (
          <IconButton
            icon="play"
            label={tr('play')}
            disabled={actions.playbackDisabled}
            onClick={() => actions.onPlay(song)}
          />
        )}
        {active && (
          <IconButton
            icon="stop"
            variant="danger"
            label={tr('cancel')}
            onClick={actions.onStop}
          />
        )}
        <IconButton
          ref={menuAnchor}
          variant="ghost"
          icon="more"
          label={tr('processingJobActions')}
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
