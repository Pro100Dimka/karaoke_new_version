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
import { useQuery } from '@tanstack/react-query';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { RecordingAnalysisProgress } from '../../../../contracts/clients';
import type { RecordingDto } from '../../../../contracts/models';
import { desktopClient as files } from '../../../../services/desktopClient';
import { pythonClient as catalog } from '../../../../services/pythonClient';
import { toAppError } from '../../../../shared/errors';
import { useNearView } from '../../../../shared/hooks/useNearView';
import { useGuardedAction } from '../../songs/useGuardedAction';
import { recordingStatusLabels } from '../../songs/songMetadataPresentation';
import { analysisStageLabel } from '../analysis/analysisPresentation';
import performanceArtUrl from '../analysis/performance-art.svg';
import { RecordingPlayer } from './RecordingPlayer';

const unavailableAnalysisLabels: Partial<
  Record<NonNullable<RecordingDto['fileStatus']>, string>
> = {
  Missing: 'recordingFileMissing',
  RecoveredIncomplete: 'errorRecordingTimingUnavailable',
};

/** The take's name, renamed in place: Enter or the check saves, Escape keeps the old one. */
const TakeName = ({
  name,
  onRename,
}: {
  name: string;
  onRename(name: string): Promise<boolean>;
}) => {
  useLocale();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const save = async () => {
    if (draft === null || pending.current) return;
    pending.current = true;
    setSaving(true);
    try {
      if (await onRename(draft)) setDraft(null);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
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
          label={tr('renameTake')}
          onClick={() => setDraft(name)}
        />
      </div>
    );
  return (
    <form
      noValidate
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <TextField
        size="sm"
        aria-label={tr('renameTake')}
        autoFocus
        value={draft}
        disabled={saving}
        onValueChange={setDraft}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(null);
          }
        }}
        endAdornment={
          <IconButton
            type="submit"
            size="xs"
            variant="ghost"
            icon="check"
            label={tr('save')}
            disabled={saving}
          />
        }
      />
    </form>
  );
};

interface RecordingCardProps {
  recording: RecordingDto;
  measureElement?: (element: Element | null) => void;
  versions?: readonly RecordingDto[];
  name: string;
  index: number;
  onRename(recording: RecordingDto, name: string): Promise<boolean>;
  onAnalyze(recording: RecordingDto, recalculate?: boolean): void;
  onDelete(recording: RecordingDto): void;
  progress?: Readonly<Record<string, RecordingAnalysisProgress>>;
  failures?: Readonly<Record<string, string>>;
  onCancelAnalysis?(jobId: string): void;
  /** Long galleries defer the whole body, including its query observer. */
  deferBody?: boolean;
}

/** One take: its picture, name, file and analysis state, player and actions. */
const RecordingCardBody = ({
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
  nearView,
}: RecordingCardProps & { nearView: boolean }) => {
  useLocale();
  const guarded = useGuardedAction();
  const [versionId, setVersionId] = useState(recording.id);
  const selected = versions.find((item) => item.id === versionId) ?? recording;
  const fileStatus = selected.fileStatus ?? 'Ready';
  const preparing = ['Preparing', 'PreparationFailed'].includes(fileStatus);
  const unavailableAnalysis = unavailableAnalysisLabels[fileStatus];
  const task = progress[selected.id];
  const failure = failures[selected.id];
  const hasAnalysis =
    selected.analysisStatus === 'Succeeded' ||
    (selected.analyzed && !selected.analysisStatus);
  const analysis = useQuery({
    queryKey: ['recording-analysis', selected.id, selected.analysisStatus],
    queryFn: () => catalog.latestAnalysis(selected.id),
    enabled: nearView && hasAnalysis && !preparing,
    staleTime: 60_000,
  });
  const statuses = recordingStatusLabels(
    fileStatus,
    task
      ? task.state === 'Queued'
        ? 'Queued'
        : 'Running'
      : (selected.analysisStatus ?? 'NotAnalyzed'),
  );

  return (
    <Card border padding="sm" className="recordingCard">
      <img
        className="recordingArt"
        src={`${performanceArtUrl}#pf-view-${(index % 6) + 1}`}
        alt=""
      />
      <div className="recordingMain">
        <TakeName
          name={name}
          onRename={(value) => onRename(recording, value)}
        />
        {versions.length > 0 && (
          <SegmentedControl
            size="sm"
            label={tr('recordingVersion')}
            value={selected.id}
            onValueChange={setVersionId}
            items={[recording, ...versions].map((item) => ({
              value: item.id,
              label: tr(
                item.sourceRecordingId
                  ? 'studioMasterTitle'
                  : 'recordingOriginal',
              ),
            }))}
          />
        )}
        <Typography variant="caption" tone="muted">
          {statuses.map((key) => tr(key)).join('  •  ')}
        </Typography>
        {task && (
          <>
            <Typography variant="caption" role="status">
              {tr(analysisStageLabel(task.stage))} · {task.progress}%
            </Typography>
            <ProgressBar
              label={tr(analysisStageLabel(task.stage))}
              value={task.progress}
              indeterminate={task.state === 'Queued'}
            />
          </>
        )}
        {failure && <MessageBar tone="error">{tr(failure)}</MessageBar>}
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
            title={tr('analysisOverall')}
          >
            {analysis.data.score}
          </Typography>
        )}
        {preparing ? null : task ? (
          <IconButton
            icon="stop"
            label={tr('analysisCancel')}
            disabled={!task.jobId}
            onClick={() => task.jobId && onCancelAnalysis?.(task.jobId)}
          />
        ) : hasAnalysis ? (
          <IconButton
            size="sm"
            variant="secondary"
            icon="levels"
            label={tr('recordingOpenAnalysis')}
            onClick={() => onAnalyze(selected)}
          />
        ) : (
          <IconButton
            icon="levels"
            label={tr(unavailableAnalysis ?? 'recordingAnalyze')}
            disabled={Boolean(unavailableAnalysis)}
            onClick={() => onAnalyze(selected)}
          />
        )}
        <IconButton
          icon="folder"
          label={tr('openFolder')}
          onClick={() =>
            void guarded(async () => {
              const current = await catalog.getRecording(selected.id);
              await files.revealInExplorer(current.filePath);
            })
          }
        />
        <IconButton
          icon="trash"
          variant="danger"
          label={tr('recordingDelete')}
          disabled={selected.fileStatus === 'Preparing'}
          onClick={() => onDelete(selected)}
        />
      </div>
    </Card>
  );
};

/** Plain rows reserve the card's layout without animated controls or query subscriptions. */
const RecordingCardPlaceholder = ({
  recording,
  versions = [],
  name,
  progress = {},
  failures = {},
}: RecordingCardProps) => {
  useLocale();
  const task = progress[recording.id];
  const failure = failures[recording.id];
  const statuses = recordingStatusLabels(
    recording.fileStatus ?? 'Ready',
    task
      ? task.state === 'Queued'
        ? 'Queued'
        : 'Running'
      : (recording.analysisStatus ?? 'NotAnalyzed'),
  );
  return (
    <div className="recordingCardPlaceholder" aria-hidden="true">
      <div className="recordingArt" />
      <div className="recordingMain">
        <div className="recordingName">
          <strong>{name}</strong>
        </div>
        {versions.length > 0 && (
          <div
            className="recordingPlaceholderVersions"
            data-placeholder="versions"
          >
            {tr('recordingOriginal')} · {tr('studioMasterTitle')}
          </div>
        )}
        <span className="recordingPlaceholderCaption">
          {statuses.map((key) => tr(key)).join('  •  ')}
        </span>
        {task && (
          <>
            <span className="recordingPlaceholderCaption">
              {tr(analysisStageLabel(task.stage))} · {task.progress}%
            </span>
            <div
              className="recordingPlaceholderProgress"
              data-placeholder="progress"
            />
          </>
        )}
        {failure && (
          <div
            className="recordingPlaceholderFailure"
            data-placeholder="failure"
          >
            <span>{tr(failure)}</span>
          </div>
        )}
        <div className="recordingPlayer recordingPlayerPending" />
      </div>
      <div className="recordingActions" />
    </div>
  );
};

const RecordingCardView = (props: RecordingCardProps) => {
  const { deferBody = false, measureElement } = props;
  const card = useRef<HTMLLIElement>(null);
  const setCardRef = useCallback(
    (element: HTMLLIElement | null) => {
      card.current = element;
      measureElement?.(element);
    },
    [measureElement],
  );
  const nearView = useNearView(card);
  const [mounted, setMounted] = useState(!deferBody);
  const focusActivated = useRef(false);
  const focusEntry = useRef<'first' | 'last' | null>(null);
  const showBody = !deferBody || mounted || nearView;
  // A focused view can become a large gallery (or vice versa). Once created,
  // keep the body so version, draft and playback state survive these transitions.
  useEffect(() => {
    if (!deferBody) setMounted(true);
  }, [deferBody]);
  useLayoutEffect(() => {
    const direction = focusEntry.current;
    focusEntry.current = null;
    const element = card.current;
    if (
      !direction ||
      !element ||
      element.ownerDocument.activeElement !== element
    )
      return;
    const controls = Array.from(
      element.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]',
      ),
    ).filter(
      (control) =>
        control.tabIndex >= 0 &&
        !control.matches(':disabled') &&
        !control.closest('[hidden], [inert], [aria-hidden="true"]'),
    );
    (direction === 'last' ? controls.at(-1) : controls[0])?.focus();
  }, [showBody]);

  return (
    <li
      ref={setCardRef}
      data-index={props.index}
      tabIndex={showBody ? undefined : 0}
      aria-label={showBody ? undefined : props.name}
      onFocus={(event) => {
        if (showBody || event.target !== event.currentTarget) return;
        const from = event.relatedTarget;
        focusEntry.current =
          from instanceof Node &&
          event.currentTarget.compareDocumentPosition(from) &
            Node.DOCUMENT_POSITION_FOLLOWING
            ? 'last'
            : 'first';
        focusActivated.current = true;
        setMounted(true);
      }}
    >
      {showBody ? (
        <RecordingCardBody
          {...props}
          nearView={nearView || focusActivated.current}
        />
      ) : (
        <RecordingCardPlaceholder {...props} />
      )}
    </li>
  );
};

/** Progress for an unrelated take must not re-render this card or its waveform. */
const sameTakeProgress = (
  previous: Readonly<Record<string, RecordingAnalysisProgress>>,
  next: Readonly<Record<string, RecordingAnalysisProgress>>,
  recording: RecordingDto,
  versions: readonly RecordingDto[],
): boolean =>
  [recording, ...versions].every((item) => previous[item.id] === next[item.id]);

const sameTakeFailures = (
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
  recording: RecordingDto,
  versions: readonly RecordingDto[],
): boolean =>
  [recording, ...versions].every((item) => previous[item.id] === next[item.id]);

export const RecordingCard = memo(
  RecordingCardView,
  (previous, next) =>
    previous.recording === next.recording &&
    previous.versions === next.versions &&
    previous.name === next.name &&
    previous.index === next.index &&
    previous.measureElement === next.measureElement &&
    previous.deferBody === next.deferBody &&
    previous.onRename === next.onRename &&
    previous.onAnalyze === next.onAnalyze &&
    previous.onDelete === next.onDelete &&
    previous.onCancelAnalysis === next.onCancelAnalysis &&
    sameTakeProgress(
      previous.progress ?? {},
      next.progress ?? {},
      next.recording,
      next.versions ?? [],
    ) &&
    sameTakeFailures(
      previous.failures ?? {},
      next.failures ?? {},
      next.recording,
      next.versions ?? [],
    ),
);
