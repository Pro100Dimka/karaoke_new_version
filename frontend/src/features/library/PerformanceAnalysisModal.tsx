import { BarChart3 } from "lucide-react";
import type { AnalysisDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { Modal } from "../../shared/ui/Modal";
import { Progress, Typography } from "../../theme/ui";

interface MetricDefinition {
  key: "pitch" | "rhythm" | "stability";
  label: MessageKey;
}

const metrics = [
  { key: "pitch", label: "analysisPitch" },
  { key: "rhythm", label: "analysisRhythm" },
  { key: "stability", label: "analysisStability" }
] as const satisfies readonly MetricDefinition[];

const AnalysisMetric = ({ label, value }: { label: MessageKey; value: number }) => {
  const t = useText();

  return (
    <div className="metric">
      <span>{t(label)}</span>
      <Progress aria-label={t(label)} value={value} />
      <strong>{value}</strong>
    </div>
  );
};

export const PerformanceAnalysisModal = ({ analysis, onClose }: { analysis: AnalysisDto | null; onClose(): void }) => {
  const t = useText();
  if (!analysis) return null;

  return (
    <Modal open title={t("performanceAnalysis")} closeLabel={t("closeDialog")} onClose={onClose}>
      <div className="analysis">
        <div className="score">
          <BarChart3 aria-hidden size={30} />
          <strong>{analysis.score}</strong>
          <span>{t("analysisOverall")}</span>
        </div>
        <Typography variant="body1">{analysis.summary}</Typography>
        {metrics.map(metric => (
          <AnalysisMetric key={metric.key} label={metric.label} value={analysis[metric.key]} />
        ))}
      </div>
    </Modal>
  );
};
