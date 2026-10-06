import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Dialog,
  IconButton,
  Landscape,
  NeonWaves,
  Planet,
  ProgressBar,
  Stack,
  Typography,
} from "@ad-voice/ui";
import type { StudioMasterProgress } from "../../contracts/clients";
import type { AnalysisDto, RecordingDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import performanceArtUrl from "./assets/performance-art.svg";
import {
  analysisMetrics,
  gradeLabel,
  weakestMetric,
  type AnalysisMetricKey,
} from "./analysisPresentation";
import { RecordingPlayer } from "./RecordingPlayer";
import "./analysis.css";

interface PerformanceAnalysisModalProps {
  analysis: AnalysisDto | null;
  recordings: readonly RecordingDto[];
  onDelete(recording: RecordingDto): void;
  onCreateStudioMaster(recording: RecordingDto): void;
  studioMaster: StudioMasterProgress | null;
  onClose(): void;
}

/** The song's own takes (masters are shown beside their source), plus the analysed one if it is not among them. */
const takeList = (
  recordings: readonly RecordingDto[],
  analysis: AnalysisDto,
): readonly RecordingDto[] =>
  recordings.some((recording) => recording.id === analysis.recordingId)
    ? recordings.filter((recording) => !recording.sourceRecordingId)
    : [
        ...recordings.filter((recording) => !recording.sourceRecordingId),
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

const metricIcons = {
  pitch: "music",
  rhythm: "rhythm",
  stability: "timer",
} as const satisfies Record<AnalysisMetricKey, string>;
const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** How a take went: browse the takes, listen, master the analysed one, and see its scores with a practice tip. */
export const PerformanceAnalysisModal = ({
  analysis,
  recordings,
  onDelete,
  onCreateStudioMaster,
  studioMaster,
  onClose,
}: PerformanceAnalysisModalProps) => {
  const t = useText();
  const [viewedId, setViewedId] = useState(analysis?.recordingId);
  useEffect(() => setViewedId(analysis?.recordingId), [analysis?.recordingId]);
  const list = useMemo(
    () => (analysis ? takeList(recordings, analysis) : []),
    [recordings, analysis],
  );
  if (!analysis) return null;
  const index = Math.max(
    0,
    list.findIndex((recording) => recording.id === viewedId),
  );
  const viewed = list[index];
  if (!viewed) return null;
  const previous = list[index - 1];
  const next = list[index + 1];
  const active = viewed.id === analysis.recordingId;
  const practice = weakestMetric(analysis);
  const mastering =
    studioMaster?.recordingId === viewed.id ? studioMaster : null;
  const master = recordings.find(
    (recording) => recording.sourceRecordingId === viewed.id,
  );
  const date = viewed.createdAt
    ? dateFormat.format(new Date(viewed.createdAt)).replace(",", "")
    : t("recordingTake");

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
          <Typography
            as="span"
            variant="eyebrow"
            tone="accent"
            className="analysisEyebrow"
          >
            {t("analysisEyebrow")}
          </Typography>
          {t("performanceAnalysis")}
        </>
      }
      description={t("analysisDescription")}
      closeLabel={t("closeDialog")}
      cancelLabel={false}
      confirmLabel={t("done")}
      art={<Planet className="analysisPlanet" />}
    >
      <Stack gap={3}>
        <Card border padding="sm" className="analysisNavigator">
          <IconButton
            round
            icon="back"
            label={t("previousRecording")}
            disabled={!previous}
            onClick={() => previous && setViewedId(previous.id)}
          />
          <div className="analysisTake">
            <Typography as="time" variant="title">
              {date}
            </Typography>
            <Typography variant="caption" tone="muted">
              {t("recordingOf", { current: index + 1, total: list.length })}
              {active ? ` · ${t("beingAnalysed")}` : ""}
            </Typography>
          </div>
          <IconButton
            round
            icon="back"
            className="analysisNext"
            label={t("nextRecording")}
            disabled={!next}
            onClick={() => next && setViewedId(next.id)}
          />
        </Card>

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
                <svg
                  className="analysisMasterArt"
                  viewBox="0 0 240 204"
                  aria-hidden="true"
                >
                  <use href={`${performanceArtUrl}#pf-art-4`} />
                </svg>
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
                  onClick={() => onCreateStudioMaster(viewed)}
                >
                  {t("studioMasterCreate")}
                </Button>
              )}
            </Card>
          )}
        </div>

        {active && (
          <>
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
            <Card border padding="none" className="analysisRecommendation">
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
                    {t(practice.advice)}
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
          </>
        )}
      </Stack>
    </Dialog>
  );
};
