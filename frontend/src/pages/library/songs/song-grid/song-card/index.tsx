import {
  Badge,
  Card,
  Checkbox,
  Grid,
  Icon,
  IconButton,
  ProgressBar,
  Stack,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { useQueryClient } from '@tanstack/react-query';
import { memo, useRef, useState } from 'react';
import { refreshSongs } from '../../../../../components/api-service';
import type {
  ProcessingJobDto,
  SongDto,
} from '../../../../../contracts/models';
import { desktopClient } from '../../../../../services/desktopClient';
import { pythonClient } from '../../../../../services/pythonClient';
import { ProcessingErrorDialog } from '../../../modals/processing/ProcessingError';
import {
  songStatusPresentation,
  type SongActionId,
} from '../../songPresentation';
import { useGuardedAction } from '../../useGuardedAction';
import { useSongActions } from '../../useSongActions';
import { ProcessingSignal } from './processing-signal';

type CardActionId = SongActionId | 'rehearsal';
const actionMeta: Record<
  CardActionId,
  { label: string; icon: string; variant?: 'secondary' }
> = {
  play: { label: 'play', icon: 'play' },
  rehearsal: {
    label: 'recordingRehearsal',
    icon: 'music',
    variant: 'secondary',
  },
  cancelQueued: { label: 'cancelQueueItem', icon: 'stop' },
  processingDetails: { label: 'openProcessingDetails', icon: 'list' },
  recordings: { label: 'recordings', icon: 'headphones' },
  settings: { label: 'songSettings', icon: 'settings' },
  folder: { label: 'openFolder', icon: 'folder' },
  viewError: { label: 'viewError', icon: 'warning' },
  retry: { label: 'processingRetry', icon: 'refresh' },
  delete: {
    label: 'deleteSong',
    icon: 'trash',
  },
};

/** The primary button's icon: in a room a guest picks songs, otherwise it is the song's main action. */
const primaryIcon = (
  primary: SongActionId | null,
  roomSelection?: { role: string; selected: boolean },
) => {
  if (roomSelection && roomSelection.role !== 'host')
    return roomSelection.selected ? 'check' : 'users';
  return primary ? actionMeta[primary].icon : 'processing';
};

const failedProcessingJob = async (
  song: SongDto,
): Promise<ProcessingJobDto | undefined> => {
  const jobs = (await pythonClient.listJobs())
    .filter(
      (job) =>
        job.songId === song.id && ['failed', 'interrupted'].includes(job.state),
    )
    .sort((a, b) =>
      (b.finishedAt ?? b.createdAt ?? '').localeCompare(
        a.finishedAt ?? a.createdAt ?? '',
      ),
    );
  return jobs.find((job) => job.id === song.jobId) ?? jobs[0];
};

export const SongCard = memo(
  function SongCard({
    song,
    onPlay,
    onOpenProcessing,
    onOpenSettings,
    onOpenRecordings,
    roomSelection,
    playbackDisabled = false,
    selection,
  }: {
    song: SongDto;
    onPlay(song: SongDto, rehearsal?: boolean): void;
    onOpenProcessing(songId: string): void;
    onOpenSettings(song: SongDto): void;
    onOpenRecordings(song: SongDto): void;
    roomSelection?: { role: string; selected: boolean };
    playbackDisabled?: boolean;
    selection?: {
      checked: boolean;
      active: boolean;
      disabled: boolean;
      toggle(id: string): void;
    };
  }) {
    useLocale();
    const client = useQueryClient();
    const guarded = useGuardedAction();
    const {
      confirmDelete,
      retryProcessing,
      resetLyricsAndReprocess,
      retrying,
      reportProcessingError,
      reporting,
    } = useSongActions();
    const [failure, setFailure] = useState<{ job?: ProcessingJobDto }>();
    const retryRequest = useRef(false);
    const [resolvingRetry, setResolvingRetry] = useState(false);
    const retry = () =>
      guarded(async () => {
        if (retryRequest.current) return;
        retryRequest.current = true;
        setResolvingRetry(true);
        try {
          const job =
            failure?.job ??
            (song.status === 'failed'
              ? await failedProcessingJob(song)
              : undefined);
          if (
            await retryProcessing(
              song.id,
              job?.timingOperation === 'lyrics' ? 'lyrics' : 'full',
            )
          )
            setFailure(undefined);
        } finally {
          retryRequest.current = false;
          setResolvingRetry(false);
        }
      });
    const resetLyrics = async () => {
      if (await resetLyricsAndReprocess(song.id)) setFailure(undefined);
    };
    const showError = async () => {
      setFailure({});
      try {
        const job = await failedProcessingJob(song);
        setFailure((current) => (current ? { job } : current));
      } catch {
        // The fallback explanation and report action remain available offline.
      }
    };
    const [failedArtwork, setFailedArtwork] = useState<string | null>(null);
    const presentation = songStatusPresentation[song.status];
    const allowed: readonly CardActionId[] = song.roomOwnerId
      ? ['play']
      : presentation.actions.flatMap((id): CardActionId[] =>
          id === 'play' && !roomSelection && song.status === 'ready'
            ? [id, 'rehearsal']
            : [id],
        );
    const actions = {
      play: () => onPlay(song),
      cancelQueued: () =>
        void guarded(async () => {
          if (!song.jobId) return;
          await pythonClient.cancelProcessing(song.jobId);
          await refreshSongs(client);
        }),
      rehearsal: () => onPlay(song, true),
      processingDetails: () => onOpenProcessing(song.id),
      recordings: () => onOpenRecordings(song),
      settings: () => onOpenSettings(song),
      folder: () =>
        void guarded(() =>
          desktopClient.revealProject(song.id, song.activeRevision),
        ),
      viewError: () => void showError(),
      retry: () => void retry(),
      delete: () => void confirmDelete(song),
    } satisfies Record<CardActionId, () => void>;
    const primary = presentation.primaryAction;
    const artist = song.artistMissing ? tr('artistMissing') : song.artist;

    return (
      <Card
        role="listitem"
        border
        padding="sm"
        className="songCard"
        data-selected={selection?.checked || undefined}
        style={{ height: '100%' }}
        aria-label={[artist, song.title].filter(Boolean).join(' - ')}
      >
        {selection && (
          <div className="songCardSelection">
            <Checkbox
              checked={selection.checked}
              disabled={selection.disabled}
              aria-label={tr('selectSongName', { name: song.title })}
              onValueChange={() => selection.toggle(song.id)}
            />
          </div>
        )}
        <Grid
          columns="30% minmax(0, 1fr)"
          gap={3}
          align="center"
          style={{ height: '100%' }}
          onClick={
            selection?.active && !selection.disabled
              ? () => selection.toggle(song.id)
              : undefined
          }
        >
          <Stack
            align="center"
            justify="center"
            style={{
              aspectRatio: '1',
              overflow: 'hidden',
              borderRadius: 'calc(var(--ad-radius) * 0.6)',
              background: 'var(--ad-neutral-900)',
              color: 'var(--ad-muted)',
            }}
          >
            {song.artworkUrl && song.artworkUrl !== failedArtwork ? (
              <img
                src={song.artworkUrl}
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => setFailedArtwork(song.artworkUrl ?? null)}
                style={{
                  display: 'block',
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
            ) : (
              <Icon name="music" size={36} />
            )}
          </Stack>
          <Stack gap={2} style={{ minWidth: 0, height: '100%' }}>
            <Stack
              gap={1}
              style={{ paddingInlineEnd: selection ? 28 : undefined }}
            >
              <Typography as="h2" variant="title" truncate>
                {song.title}
              </Typography>
              {artist && (
                <Typography variant="body-sm" tone="muted" truncate>
                  {artist}
                </Typography>
              )}
            </Stack>
            <Badge
              size="sm"
              tone={presentation.tone}
              style={{ alignSelf: 'start' }}
            >
              {tr(presentation.label)}
            </Badge>
            <Stack
              direction="row"
              align="center"
              wrap
              gap={2}
              style={{ marginTop: 'auto', minWidth: 0 }}
              onClick={(event) => event.stopPropagation()}
            >
              {allowed.map((id) => (
                <IconButton
                  key={id}
                  className={id === 'delete' ? 'songDeleteAction' : undefined}
                  round
                  size="sm"
                  style={{ flexShrink: 0 }}
                  icon={
                    id === primary
                      ? primaryIcon(primary, roomSelection)
                      : actionMeta[id].icon
                  }
                  label={tr(actionMeta[id].label)}
                  variant={
                    actionMeta[id].variant ??
                    (id === primary ? 'primary' : 'ghost')
                  }
                  disabled={
                    (['play', 'rehearsal'].includes(id) && playbackDisabled) ||
                    (id === 'retry' && (Boolean(retrying) || resolvingRetry))
                  }
                  onClick={actions[id]}
                />
              ))}
              {song.status === 'processing' && (
                <ProcessingSignal progress={song.progress ?? 0} song={song} />
              )}
              {song.status === 'importing' && (
                <ProgressBar
                  value={song.progress ?? 0}
                  label={tr('importing')}
                />
              )}
            </Stack>
          </Stack>
        </Grid>
        <ProcessingErrorDialog
          open={Boolean(failure)}
          title={[artist, song.title].filter(Boolean).join(' - ')}
          job={failure?.job}
          onClose={() => setFailure(undefined)}
          fallback={
            song.status === 'invalid' ? 'errorProjectInvalid' : undefined
          }
          onRetry={
            ['failed', 'invalid'].includes(song.status)
              ? () => void retry()
              : undefined
          }
          onReport={() => void reportProcessingError(song.id, failure?.job)}
          onResetLyrics={() => void resetLyrics()}
          retrying={Boolean(retrying) || resolvingRetry}
          reporting={reporting}
        />
      </Card>
    );
  },
  (previous, next) =>
    previous.song === next.song &&
    previous.onPlay === next.onPlay &&
    previous.onOpenProcessing === next.onOpenProcessing &&
    previous.onOpenSettings === next.onOpenSettings &&
    previous.onOpenRecordings === next.onOpenRecordings &&
    previous.playbackDisabled === next.playbackDisabled &&
    (['checked', 'active', 'disabled', 'toggle'] as const).every(
      (key) => previous.selection?.[key] === next.selection?.[key],
    ) &&
    previous.roomSelection?.role === next.roomSelection?.role &&
    previous.roomSelection?.selected === next.roomSelection?.selected,
);
