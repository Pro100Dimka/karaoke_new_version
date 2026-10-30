import {
  Button,
  Card,
  Dialog,
  IconButton,
  Landscape,
  MessageBar,
  NeonWaves,
  Planet,
  ProgressBar,
  Stack,
  Typography,
} from "@neo-ui-kit/react";
import { useEffect, useState } from "react";
import type {
  RecordingAnalysisProgress,
  StudioMasterProgress,
} from "../../contracts/clients";
import type {
  AnalysisDto,
  RecordingDto,
  SongDto,
} from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import "./analysis.css";
import {
  analysisMetrics,
  analysisStageLabel,
  gradeLabel,
  weakestMetric,
  type AnalysisMetricKey,
} from "./analysisPresentation";
import performanceArtUrl from "./assets/performance-art.svg";
import { RecordingPlayer } from "./RecordingPlayer";

interface PerformanceAnalysisModalProps {
  analysis: AnalysisDto | null;
  recordings: readonly RecordingDto[];
  onDelete(recording: RecordingDto): void;
  onCreateStudioMaster(recording: RecordingDto): void;
  studioMaster: StudioMasterProgress | null;
  onClose(): void;
  song?: SongDto | null;
  pending?: RecordingAnalysisProgress;
  failure?: MessageKey;
  recordingId?: string;
  onCancelAnalysis?(jobId: string): void;
}

/** The song's own takes (masters are shown beside their source), plus the analysed one if it is not among them. */
const takeList = (
  recordings: readonly RecordingDto[],
  analysis: AnalysisDto,
): readonly RecordingDto[] => {
  const takes = recordings.filter((recording) => !recording.sourceRecordingId);
  return recordings.some((recording) => recording.id === analysis.recordingId)
    ? takes
    : [
        ...takes,
        {
          id: analysis.recordingId,
          filePath: "",
          songId: "",
          displayName: "",
          createdAt: "",
          durationSeconds: 0,
          sizeBytes: 0,
          analyzed: true,
        },
      ];
};

const metricIcons = {
  pitch: "music",
  rhythm: "rhythm",
  stability: "timer",
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
}: PerformanceAnalysisModalProps) => {
  const t = useText();
  const [viewedId, setViewedId] = useState(analysis?.recordingId);
  useEffect(() => setViewedId(analysis?.recordingId), [analysis?.recordingId]);
  const list = analysis ? takeList(recordings, analysis) : recordings;
  if (!analysis && !pending && !failure) return null;
  const index = Math.max(
    0,
    list.findIndex(
      (recording) =>
        recording.id === (viewedId ?? pending?.recordingId ?? recordingId),
    ),
  );
  const viewed = list[index];
  if (!viewed && analysis) return null;
  const active = viewed?.id === analysis?.recordingId;
  const practice = analysis ? weakestMetric(analysis) : null;
  const mastering =
    studioMaster?.recordingId === viewed?.id ? studioMaster : null;
  const master = recordings.find(
    (recording) => recording.sourceRecordingId === viewed?.id,
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
          {t("performanceAnalysis")} :{" "}
          {song ? `${song.artist} — ${song.title}` : ""}
        </>
      }
      closeLabel={t("closeDialog")}
      cancelLabel={false}
      art={<Planet className="analysisPlanet" />}
    >
      <Stack gap={3}>
        {!analysis ? (
          <>
            {pending && (
              <>
                <Typography role="status">
                  {t(analysisStageLabel(pending.stage))}
                </Typography>
                <ProgressBar
                  label={t(analysisStageLabel(pending.stage))}
                  value={pending.progress}
                  indeterminate={pending.state === "Queued"}
                />
              </>
            )}
            {failure && <MessageBar tone="error">{t(failure)}</MessageBar>}
            {viewed?.fileStatus === "PreparationFailed" && <RecordingPlayer recording={viewed} />}
            {pending && (
              <Button
                icon="stop"
                variant="secondary"
                disabled={!pending.jobId}
                onClick={() =>
                  pending.jobId && onCancelAnalysis?.(pending.jobId)
                }
              >
                {t("analysisCancel")}
              </Button>
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
                          {t(gradeLabel(analysis.score))}
                        </Typography>
                        <Stack direction="row" gap={2} align="baseline">
                          <Typography
                            as="strong"
                            variant="display"
                            data-role="analysis-score"
                          >
                            {analysis.score}
                          </Typography>
                          <Typography variant="caption" tone="muted">
                            {t("analysisOverall")}
                          </Typography>
                        </Stack>
                        <Typography variant="label">
                          {t("analysisRecommendation")}
                        </Typography>
                        <Typography variant="body-sm" tone="muted">
                          {t(
                            analysis[practice.key] >= 100
                              ? "analysisPerfectAdvice"
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
                        title={t(metric.label)}
                        className="analysisMetric"
                        actions={
                          <Typography as="strong" variant="h3">
                            {analysis[metric.key]}%
                          </Typography>
                        }
                      >
                        <ProgressBar
                          label={t(metric.label)}
                          value={analysis[metric.key]}
                        />
                        <Typography variant="caption" tone="muted">
                          {t(metric.description)}
                        </Typography>
                      </Card>
                    ))}
                  </div>
                </>
              )}
              <div className="analysisTakes">
                <Card
                  border
                  padding="sm"
                  level={4}
                  icon="mic"
                  title={t("studioMasterSourceTitle")}
                  className="analysisOriginal"
                  actions={
                    <IconButton
                      size="sm"
                      variant="danger"
                      icon="trash"
                      label={t("recordingDelete")}
                      disabled={viewed.fileStatus === "Preparing"}
                      onClick={() => onDelete(viewed)}
                    />
                  }
                >
                  <RecordingPlayer key={viewed.id} recording={viewed} />
                </Card>
                {master && (
                  <Card
                    border
                    padding="sm"
                    level={4}
                    icon="sparkle"
                    title={t("studioMasterTitle")}
                    description={t("studioMasterReadyDescription")}
                    className="analysisMaster"
                    actions={
                      <img
                        className="analysisMasterArt"
                        src={`${performanceArtUrl}#pf-view-4`}
                        alt=""
                      />
                    }
                  >
                    <RecordingPlayer key={master.id} recording={master} />
                  </Card>
                )}
                {active && !master && (
                  <Card
                    border
                    padding="sm"
                    level={4}
                    icon="sparkle"
                    title={t("studioMasterTitle")}
                    description={t("studioMasterDescription")}
                    className="analysisStudio"
                  >
                    {mastering ? (
                      <Stack gap={1}>
                        <ProgressBar
                          label={t("studioMasterTitle")}
                          value={mastering.progress}
                        />
                        <Typography variant="caption" tone="muted">
                          {t("studioMasterProgressValue", {
                            progress: mastering.progress,
                          })}
                        </Typography>
                      </Stack>
                    ) : (
                      <Button
                        variant="primary"
                        icon="sparkle"
                        disabled={Boolean(viewed.fileStatus && viewed.fileStatus !== "Ready")}
                        onClick={() => onCreateStudioMaster(viewed)}
                      >
                        {t("studioMasterCreate")}
                      </Button>
                    )}
                  </Card>
                )}
              </div>
            </>
          )
        )}
      </Stack>
    </Dialog>
  );
};
