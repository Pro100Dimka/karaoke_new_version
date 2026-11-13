import { desktopClient as files } from '../../../../services/desktopClient';
import { pythonClient as catalog } from '../../../../services/pythonClient';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Card,
  IconButton,
  MessageBar,
  ProgressBar,
  SegmentedControl,
  TextField,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import type { RecordingAnalysisProgress } from '../../../../contracts/clients';
import type { MessageKey } from '../../../../i18n/messages';
import { analysisStageLabel } from '../analysis/analysisPresentation';
import type { RecordingDto } from '../../../../contracts/models';
import { ru } from '../../../../i18n/messages.ru';
import performanceArtUrl from '../analysis/performance-art.svg';
import { RecordingPlayer } from './RecordingPlayer';
import { recordingStatusLabels } from '../../songs/songMetadataPresentation';
import { useNearView } from '../../../../shared/hooks/useNearView';
import { toAppError } from '../../../../shared/errors';

/** The take's name, renamed in place: Enter or the check saves, Escape keeps the old one. */
const TakeName = ({
  name,
  onRename,
}: {
  name: string;
  onRename(name: string): void;
}) => {
  useLocale();
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null)
    return (
      <div className="recordingName">
        <Typography as="strong" variant="title" truncate>
          {name}
        </Typography>
        <IconButton
          size="xs"
          variant="ghost"
          icon="pencil"
          label={tr(ru.renameTake)}
          onClick={() => setDraft(name)}
        />
      </div>
    );
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onRename(draft);
        setDraft(null);
      }}
    >
      <TextField
        size="sm"
        aria-label={tr(ru.renameTake)}
        autoFocus
        value={draft}
        onValueChange={setDraft}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(null);
        }}
        endAdornment={
          <IconButton
            type="submit"
            size="xs"
            variant="ghost"
            icon="check"
            label={tr(ru.save)}
          />
        }
      />
    </form>
  );
};

/** One take: its picture, name, file and analysis state, player and actions. */
export const RecordingCard = ({
  recording,
  versions = [],
  name,
  index,
  onRename,
  onAnalyze,
  onDelete,
  progress = {},
  failures = {},
  onCancelAnalysis,
}: {
  recording: RecordingDto;
  versions?: readonly RecordingDto[];
  name: string;
  index: number;
  onRename(name: string): void;
  onAnalyze(recording: RecordingDto, recalculate?: boolean): void;
  onDelete(recording: RecordingDto): void;
  progress?: Readonly<Record<string, RecordingAnalysisProgress>>;
  failures?: Readonly<Record<string, MessageKey>>;
  onCancelAnalysis?(jobId: string): void;
}) => {
  useLocale();
  const [versionId, setVersionId] = useState(recording.id);
  const selected = versions.find((item) => item.id === versionId) ?? recording;
  const preparing = ['Preparing', 'PreparationFailed'].includes(
    selected.fileStatus ?? '',
  );
  const task = progress[selected.id];
  const failure = failures[selected.id];
  const hasAnalysis =
    selected.analysisStatus === 'Succeeded' ||
    (selected.analyzed && !selected.analysisStatus);
  // A song can have dozens of takes; each player's waveform is dozens of animated parts, so it is
  // drawn only once its card scrolls near the view and the list opens at once.
  const card = useRef<HTMLLIElement>(null);
  const nearView = useNearView(card);
  const analysis = useQuery({
    queryKey: ['recording-analysis', selected.id, selected.analysisStatus],
    queryFn: () => catalog.latestAnalysis(selected.id),
    enabled: nearView && hasAnalysis && !preparing,
    staleTime: 60_000,
  });
  const statuses = recordingStatusLabels(
    selected.fileStatus ?? 'Ready',
    task
      ? task.state === 'Queued'
        ? 'Queued'
        : 'Running'
      : (selected.analysisStatus ?? 'NotAnalyzed'),
  );

  return (
    <li ref={card}>
      <Card border padding="sm" className="recordingCard">
        <img
          className="recordingArt"
          src={`${performanceArtUrl}#pf-view-${(index % 6) + 1}`}
          alt=""
        />
        <div className="recordingMain">
          <TakeName name={name} onRename={onRename} />
          {versions.length > 0 && (
            <SegmentedControl
              size="sm"
              label={tr(ru.recordingVersion)}
              value={selected.id}
              onValueChange={setVersionId}
              items={[recording, ...versions].map((item) => ({
                value: item.id,
                label: tr(
                  ru[
                    item.sourceRecordingId
                      ? 'studioMasterTitle'
                      : 'recordingOriginal'
                  ],
                ),
              }))}
            />
          )}
          <Typography variant="caption" tone="muted">
            {statuses.map((key) => tr(ru[key])).join('  •  ')}
          </Typography>
          {task && (
            <>
              <Typography variant="caption" role="status">
                {tr(ru[analysisStageLabel(task.stage)])} · {task.progress}%
              </Typography>
              <ProgressBar
                label={tr(ru[analysisStageLabel(task.stage)])}
                value={task.progress}
                indeterminate={task.state === 'Queued'}
              />
            </>
          )}
          {failure && <MessageBar tone="error">{tr(ru[failure])}</MessageBar>}
          {analysis.isError && (
            <MessageBar tone="error">
              {tr(toAppError(analysis.error).message)}
            </MessageBar>
          )}
          {nearView ? (
            <RecordingPlayer key={selected.id} recording={selected} />
          ) : (
            <div
              className="recordingPlayer recordingPlayerPending"
              aria-hidden="true"
            />
          )}
        </div>
        <div className="recordingActions">
          {analysis.data && (
            <Typography
              as="strong"
              variant="h3"
              tone="accent"
              title={tr(ru.analysisOverall)}
            >
              {analysis.data.score}
            </Typography>
          )}
          {preparing ? null : task ? (
            <IconButton
              icon="stop"
              label={tr(ru.analysisCancel)}
              disabled={!task.jobId}
              onClick={() => task.jobId && onCancelAnalysis?.(task.jobId)}
            />
          ) : hasAnalysis ? (
            <IconButton
              size="sm"
              variant="secondary"
              icon="levels"
              label={tr(ru.recordingOpenAnalysis)}
              onClick={() => onAnalyze(selected)}
            />
          ) : (
            <IconButton
              icon="levels"
              label={tr(
                ru[
                  selected.fileStatus === 'RecoveredIncomplete'
                    ? 'errorRecordingTimingUnavailable'
                    : 'recordingAnalyze'
                ],
              )}
              disabled={selected.fileStatus === 'RecoveredIncomplete'}
              onClick={() => onAnalyze(selected)}
            />
          )}
          <IconButton
            icon="folder"
            label={tr(ru.openFolder)}
            onClick={async () => {
              const current = await catalog.getRecording(selected.id);
              await files.revealInExplorer(current.filePath);
            }}
          />
          <IconButton
            icon="trash"
            variant="danger"
            label={tr(ru.recordingDelete)}
            disabled={selected.fileStatus === 'Preparing'}
            onClick={() => onDelete(selected)}
          />
        </div>
      </Card>
    </li>
  );
};
