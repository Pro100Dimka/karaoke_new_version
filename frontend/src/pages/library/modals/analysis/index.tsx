import {
  Button,
  Card,
  Dialog,
  IconButton,
  Landscape,
  Loader,
  MessageBar,
  NeonWaves,
  Planet,
  ProgressBar,
  Stack,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { useEffect, useState } from 'react';
import type {
  RecordingAnalysisProgress,
  StudioMasterProgress,
} from '../../../../contracts/clients';
import type {
  AnalysisDto,
  RecordingDto,
  SongDto,
} from '../../../../contracts/models';
import { RecordingPlayer } from '../recordings/RecordingPlayer';
import { desktopClient } from '../../../../services/desktopClient';
import { pythonClient } from '../../../../services/pythonClient';
import { useGuardedAction } from '../../songs/useGuardedAction';
import './analysis.css';
import {
  analysisMetrics,
  analysisStageLabel,
  gradeLabel,
  studioMasterStageLabel,
  weakestMetric,
  type AnalysisMetricKey,
} from './analysisPresentation';

interface PerformanceAnalysisModalProps {
  analysis: AnalysisDto | null;
  recordings: readonly RecordingDto[];
  onDelete(recording: RecordingDto): void;
  onCreateStudioMaster(recording: RecordingDto): void;
  studioMaster: StudioMasterProgress | null;
  onClose(): void;
  song?: SongDto | null;
  pending?: RecordingAnalysisProgress;
  failure?: string;
  recordingId?: string;
  onCancelAnalysis?(jobId: string): void;
  onRetryAnalysis?(): void;
}

/** Keep retained masters playable when their source take has been deleted. */
const takeList = (
  recordings: readonly RecordingDto[],
): readonly RecordingDto[] =>
  recordings.filter(
    (recording) =>
      !recording.sourceRecordingId ||
      !recordings.some((source) => source.id === recording.sourceRecordingId),
  );

const metricIcons = {
  pitch: 'music',
  rhythm: 'rhythm',
  stability: 'timer',
} as const satisfies Record<AnalysisMetricKey, string>;

/** How a take went: browse the takes, listen, master the analysed one, and see its scores with a practice tip. */
export const PerformanceAnalysisModal = ({
  analysis,
  recordings,
  onDelete,
  onCreateStudioMaster,
  studioMaster,
  onClose,
  song,
  pending,
  failure,
  recordingId,
  onCancelAnalysis,
  onRetryAnalysis,
}: PerformanceAnalysisModalProps) => {
  useLocale();
  const guarded = useGuardedAction();
  // Resolve the selected master's own take before its analysis result arrives.
  const analyzed = recordings.find(
    (recording) =>
      recording.id ===
      (analysis?.recordingId ?? pending?.recordingId ?? recordingId),
  );
  const analyzedTakeId = recordings.some(
    (recording) => recording.id === analyzed?.sourceRecordingId,
  )
    ? analyzed?.sourceRecordingId
    : analyzed?.id;
  const [viewedId, setViewedId] = useState(analyzedTakeId);
  useEffect(() => setViewedId(analyzedTakeId), [analyzedTakeId]);
  const list = takeList(recordings);
  if (!analysis && !pending && !failure) return null;
  const viewed =
    list.find(
      (recording) =>
        recording.id === (viewedId ?? pending?.recordingId ?? recordingId),
    ) ?? list[0];
  if (!viewed && analysis) return null;
  const active = viewed?.id === analyzedTakeId;
  const roomPerformance = viewed?.roomPerformance;
  const overallScore = roomPerformance
    ? roomPerformance.overallScore
    : analysis?.score;
  const practice = analysis ? weakestMetric(analysis) : null;
  const mastering =
    studioMaster?.recordingId === viewed?.id ? studioMaster : null;
  const master =
    analyzed?.sourceRecordingId === viewed?.id
      ? analyzed
      : recordings.find(
          (recording) => recording.sourceRecordingId === viewed?.id,
        );
  const fileActions = (recording: RecordingDto) => (
    <Stack direction="row" gap={2}>
      {[
        {
          icon: 'folder',
          label: tr('openFolder'),
          variant: 'secondary' as const,
          onClick: () =>
            void guarded(async () => {
              const current = await pythonClient.getRecording(recording.id);
              await desktopClient.revealInExplorer(current.filePath);
            }),
        },
        {
          icon: 'trash',
          label: tr('recordingDelete'),
          variant: 'danger' as const,
          onClick: () => onDelete(recording),
        },
      ].map((action) => (
        <IconButton key={action.icon} size="sm" {...action} />
      ))}
    </Stack>
  );

  const preparingPanel = (
    <Card border padding="sm" className="analysisPreparing">
      <Loader animation="wave" size="lg" label={tr('recordingPreparing')} />
      <Typography tone="muted">{tr('recordingPreparing')}</Typography>
    </Card>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="analysisDialog"
      width="large"
      icon="wave"
      title={
        <>
          <span className="analysisSongTitle">
            {song?.title ?? tr('performanceAnalysis')}
          </span>
          {song && (
            <span className="analysisArtist">
              {song.artist}
              <span className="analysisEyebrow">
                {tr('performanceAnalysis')}
              </span>
            </span>
          )}
        </>
      }
      closeLabel={tr('closeDialog')}
      cancelLabel={false}
      art={<Planet className="analysisPlanet" />}
    >
      <Stack gap={3}>
        {!analysis ? (
          <>
            {viewed?.fileStatus === 'Preparing' && preparingPanel}
            {pending && (
              <>
                <Typography role="status">
                  {tr(analysisStageLabel(pending.stage))}
                </Typography>
                <ProgressBar
                  label={tr(analysisStageLabel(pending.stage))}
                  value={pending.progress}
                  indeterminate={pending.state === 'Queued'}
                />
              </>
            )}
            {failure && (
              <MessageBar
                tone="error"
                action={
                  onRetryAnalysis && !pending ? (
                    <Button label={tr('retry')} onClick={onRetryAnalysis} />
                  ) : undefined
                }
              >
                {tr(failure)}
              </MessageBar>
            )}
            {viewed?.fileStatus === 'PreparationFailed' && (
              <RecordingPlayer recording={viewed} />
            )}
            {pending && (
              <Button
                icon="stop"
                variant="secondary"
                disabled={!pending.jobId}
                onClick={() =>
                  pending.jobId && onCancelAnalysis?.(pending.jobId)
                }
                label={tr('analysisCancel')}
              />
            )}
          </>
        ) : (
          viewed &&
          practice && (
            <>
              {active && (
                <>
                  <Card
                    border
                    padding="none"
                    className="analysisRecommendation"
                  >
                    <Landscape className="analysisLandscape">
                      <div className="analysisVerdict">
                        <Typography variant="eyebrow" tone="accent">
                          {tr(
                            overallScore === undefined
                              ? 'roomPerformanceOverall'
                              : gradeLabel(overallScore),
                          )}
                        </Typography>
                        <Stack direction="row" gap={2} align="baseline">
                          <Typography
                            as="strong"
                            variant={
                              overallScore === undefined ? 'caption' : 'display'
                            }
                            data-role="analysis-score"
                          >
                            {overallScore ??
                              tr(
                                roomPerformance?.status === 'pending'
                                  ? 'roomPerformancePending'
                                  : 'roomPerformanceUnavailable',
                              )}
                          </Typography>
                          {overallScore !== undefined && (
                            <Typography variant="caption" tone="muted">
                              {tr(
                                roomPerformance
                                  ? 'roomPerformanceOverall'
                                  : 'analysisOverall',
                              )}
                            </Typography>
                          )}
                        </Stack>
                        {roomPerformance && (
                          <>
                            <Stack direction="row" gap={2} align="baseline">
                              <Typography variant="caption" tone="muted">
                                {tr('roomPerformancePersonal')}
                              </Typography>
                              <Typography as="strong" variant="h3">
                                {analysis.score}
                              </Typography>
                            </Stack>
                            <Typography variant="caption" tone="muted">
                              {tr('roomPerformanceDuetHint')}
                            </Typography>
                          </>
                        )}
                        <Typography variant="label">
                          {tr('analysisRecommendation')}
                        </Typography>
                        <Typography variant="body-sm" tone="muted">
                          {tr(
                            analysis[practice.key] >= 100
                              ? 'analysisPerfectAdvice'
                              : practice.advice,
                          )}
                        </Typography>
                      </div>
                    </Landscape>
                    <NeonWaves
                      className="analysisFlow"
                      shape="ridge"
                      comets={3}
                      strands={26}
                    />
                  </Card>
                  <div className="analysisMetrics">
                    {analysisMetrics.map((metric) => (
                      <Card
                        key={metric.key}
                        material="glass"
                        padding="sm"
                        level={4}
                        icon={metricIcons[metric.key]}
                        title={tr(metric.label)}
                        className="analysisMetric"
                        actions={
                          <Typography as="strong" variant="h3">
                            {analysis[metric.key]}%
                          </Typography>
                        }
                      >
                        <ProgressBar
                          variant="wave"
                          label={tr(metric.label)}
                          value={analysis[metric.key]}
                        />
                        <Typography variant="caption" tone="muted">
                          {tr(metric.description)}
                        </Typography>
                      </Card>
                    ))}
                  </div>
                </>
              )}
              {song?.sourcePath && (
                <Card
                  border
                  padding="sm"
                  level={4}
                  icon="music"
                  title={tr('originalSong')}
                  className="analysisSong"
                  actions={
                    <IconButton
                      size="sm"
                      icon="folder"
                      label={tr('openFolder')}
                      onClick={() =>
                        void guarded(async () => {
                          const current = await pythonClient.getSong(song.id);
                          if (current.sourcePath)
                            await desktopClient.revealInExplorer(
                              current.sourcePath,
                            );
                        })
                      }
                    />
                  }
                >
                  <RecordingPlayer key={song.id} song={song} />
                </Card>
              )}
              <div className="analysisTakes">
                {viewed.fileStatus === 'Preparing' ? (
                  preparingPanel
                ) : (
                  <>
                    <Card
                      border
                      padding="sm"
                      level={4}
                      icon={viewed.sourceRecordingId ? 'sparkle' : 'mic'}
                      title={tr(
                        viewed.sourceRecordingId
                          ? 'studioMasterTitle'
                          : 'studioMasterSourceTitle',
                      )}
                      className="analysisOriginal"
                      actions={fileActions(viewed)}
                    >
                      <RecordingPlayer key={viewed.id} recording={viewed} />
                    </Card>
                    {(master || (active && !viewed.sourceRecordingId)) && (
                      <Card
                        key={master ? 'master' : 'studio'}
                        border
                        padding="sm"
                        level={4}
                        icon="sparkle"
                        title={tr('studioMasterTitle')}
                        description={tr(
                          master ? '' : 'studioMasterDescription',
                        )}
                        className={master ? 'analysisMaster' : 'analysisStudio'}
                        actions={master && fileActions(master)}
                      >
                        {master ? (
                          <RecordingPlayer key={master.id} recording={master} />
                        ) : mastering ? (
                          <Stack gap={1}>
                            <ProgressBar
                              label={tr(
                                studioMasterStageLabel(mastering.stage),
                              )}
                              value={mastering.progress}
                            />
                            <Typography variant="caption" tone="muted">
                              {tr('studioMasterProgressValue', {
                                progress: mastering.progress,
                              })}
                            </Typography>
                          </Stack>
                        ) : (
                          <Button
                            variant="primary"
                            icon="sparkle"
                            disabled={Boolean(
                              viewed.fileStatus &&
                              viewed.fileStatus !== 'Ready',
                            )}
                            onClick={() => onCreateStudioMaster(viewed)}
                            label={tr('studioMasterCreate')}
                          />
                        )}
                      </Card>
                    )}
                  </>
                )}
              </div>
            </>
          )
        )}
      </Stack>
    </Dialog>
  );
};
