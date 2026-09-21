import { BarChart3 } from "lucide-react";
import type { AnalysisDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { Button, Card, Grid, Modal, Stack, Typography } from "../../theme/ui";
import { analysisMetrics, gradeLabel, weakestMetric } from "./analysisPresentation";
import "./analysis.css";

/** Result of a performance: one card per metric (the weakest is marked for practice), then the overall score with a recommendation. */
export const PerformanceAnalysisModal = ({ analysis, onClose }: { analysis: AnalysisDto | null; onClose(): void }) => {
  const t = useText();
  if (!analysis) return null;
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
      <Stack align="center" gap="var(--space-4)" className="analysisBody">
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
            <Typography variant="h4" textAlign="center">
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
      </Stack>
    </Modal>
  );
};
