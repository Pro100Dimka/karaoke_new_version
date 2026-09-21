import { BarChart3, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AnalysisDto, RecordingDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { Button, Card, Grid, IconButton, Modal, ModalCarouselNavigation, Stack, Typography } from "../../theme/ui";
import { analysisMetrics, gradeLabel, weakestMetric } from "./analysisPresentation";
import { RecordingPlayer } from "./RecordingPlayer";
import "./analysis.css";

interface PerformanceAnalysisModalProps {
  analysis: AnalysisDto | null;
  recordings: readonly RecordingDto[];
  onDelete(recording: RecordingDto): void;
  onClose(): void;
}

/** The take being analysed, or a stand-in when the song's list does not contain it yet. */
const takeList = (recordings: readonly RecordingDto[], analysis: AnalysisDto): readonly RecordingDto[] =>
  recordings.some(recording => recording.id === analysis.recordingId)
    ? recordings
    : [...recordings, { id: analysis.recordingId, filePath: "", songId: "", displayName: "", createdAt: "", durationSeconds: 0, analyzed: true }];

/**
 * Result of a performance: the take with its player and delete button, one card per metric (the weakest is marked for
 * practice), then the overall score with a recommendation. Other takes of the song can be browsed and listened to.
 */
export const PerformanceAnalysisModal = ({ analysis, recordings, onDelete, onClose }: PerformanceAnalysisModalProps) => {
  const t = useText();
  const [viewedId, setViewedId] = useState(analysis?.recordingId);
  useEffect(() => setViewedId(analysis?.recordingId), [analysis?.recordingId]);
  const list = useMemo(() => (analysis ? takeList(recordings, analysis) : []), [recordings, analysis]);
  if (!analysis) return null;

  const index = Math.max(0, list.findIndex(recording => recording.id === viewedId));
  const viewed = list[index];
  if (!viewed) return null;

  const previous = index > 0 ? list[index - 1] : undefined;
  const next = index < list.length - 1 ? list[index + 1] : undefined;
  const active = viewed.id === analysis.recordingId;
  const practice = weakestMetric(analysis);

  return (
    <Modal
      isOpen
      onClose={onClose}
      ariaLabel={t("performanceAnalysis")}
      closeAriaLabel={t("closeDialog")}
      closeIconSize={40}
      cardVariant="laser"
      portal
      size="lg"
      titleProps={{
        icon: BarChart3,
        eyebrow: t("analysisEyebrow"),
        title: t("performanceAnalysis"),
        description: t("analysisDescription"),
        actions: <Button onClick={onClose}>{t("done")}</Button>
      }}
    >
      <Stack gap="var(--space-4)" className="analysisBody">
        <ModalCarouselNavigation
          ariaLabel={t("recordings")}
          index={index}
          count={list.length}
          title={viewed.createdAt ? new Date(viewed.createdAt).toLocaleString() : t("recordingTake")}
          subtitle={`${t("recordingOf", { current: index + 1, total: list.length })}${active ? ` · ${t("beingAnalysed")}` : ""}`}
          previousLabel={t("previousRecording")}
          nextLabel={t("nextRecording")}
          onPrevious={previous ? () => setViewedId(previous.id) : undefined}
          onNext={next ? () => setViewedId(next.id) : undefined}
        />
        {!active && <Typography tone="muted">{t("viewingAnotherRecording")}</Typography>}
        <Stack direction="row" align="center" gap="var(--space-2)">
          <RecordingPlayer key={viewed.id} recording={viewed} />
          <IconButton icon={Trash2} tone="danger" variant="outline" label={t("recordingDelete")} onClick={() => onDelete(viewed)} />
        </Stack>
        {active && (
          <>
            <Grid columns={3} gap="var(--space-3)">
              {analysisMetrics.map(metric => (
                <Card key={metric.key} data-practice={metric.key === practice.key || undefined}>
                  <Stack gap="var(--space-1)" className="analysisMetric">
                    <Stack direction="row" align="baseline" justify="space-between" gap="var(--space-2)">
                      <Typography>
                        <strong>{t(metric.label)}</strong>
                      </Typography>
                      <Typography variant="h4">{analysis[metric.key]}%</Typography>
                    </Stack>
                    <Typography variant="caption" tone="muted">
                      {t(metric.description)}
                    </Typography>
                  </Stack>
                </Card>
              ))}
            </Grid>
            <Card variant="laser" tilt={false} cardContent={{ className: "analysisScoreContent" }}>
              <Stack align="center" gap="var(--space-1)">
                <Typography variant="h4" align="center">
                  {t(gradeLabel(analysis.score))}
                </Typography>
                <Typography variant="h3" data-role="analysis-score">
                  {analysis.score}
                </Typography>
                <Typography tone="muted">{t("analysisOverall")}</Typography>
              </Stack>
              <Stack gap="var(--space-2)">
                <Typography>
                  <strong>{t("analysisRecommendation")}</strong>
                </Typography>
                <Typography tone="muted">{t(practice.advice)}</Typography>
              </Stack>
            </Card>
          </>
        )}
      </Stack>
    </Modal>
  );
};
