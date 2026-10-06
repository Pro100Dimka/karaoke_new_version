import {
  Button,
  Card,
  ProgressBar,
  StatusIndicator,
  Typography,
} from "@ad-voice/ui";
import type { ModelDto, ProcessingJobDto } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { formatBytes } from "../../../../shared/utils/format";
import {
  canDownload,
  modelStateLabel,
  requiredDiskBytes,
} from "./aiModelModel";
import { isJobActive } from "./useAiSettings";

const stateTone: Record<
  ModelDto["state"],
  "success" | "error" | "processing" | "warning"
> = {
  ready: "success",
  failed: "error",
  downloading: "processing",
  "update-available": "warning",
  "not-installed": "warning",
};

/** One AI model: its state, sizes, download progress and the action that fits the state. */
export const ModelCard = ({
  model,
  job,
  free,
  onDownload,
  onCancel,
}: {
  model: ModelDto;
  job?: ProcessingJobDto;
  free: number | null;
  onDownload(model: ModelDto): void;
  onCancel(jobId: string): void;
}) => {
  const t = useText();
  const busy = model.state === "downloading" || isJobActive(job);
  const downloadable = canDownload(model);
  const required = requiredDiskBytes(model);
  const insufficient = free !== null && free < required;
  const action = () => {
    if (busy && job)
      return (
        <Button
          size="sm"
          variant="ghost"
          icon="close"
          onClick={() => onCancel(job.id)}
        >
          {t("cancel")}
        </Button>
      );
    if (!busy && downloadable)
      return (
        <Button
          size="sm"
          variant="primary"
          icon="download"
          disabled={insufficient}
          onClick={() => onDownload(model)}
        >
          {model.state === "failed" ? t("retry") : t("download")}
        </Button>
      );
    return null;
  };

  return (
    <Card
      material="glass"
      padding="sm"
      level={4}
      icon={model.purpose === "Separation" ? "cube" : "audio"}
      title={`${model.purpose} (${model.id})`}
      actions={action()}
    >
      <div className="settingsStack">
        <StatusIndicator
          status={stateTone[model.state]}
          label={t(modelStateLabel[model.state])}
        />
        {downloadable && (
          <Typography variant="caption" tone="muted">
            {t("modelSizes", {
              download: formatBytes(model.sizeBytes),
              required: formatBytes(required),
            })}
          </Typography>
        )}
        {busy && (
          <ProgressBar
            label={t("modelDownloading")}
            value={job?.progress ?? 0}
          />
        )}
        {job?.state === "failed" && (
          <Typography role="alert" variant="caption" tone="danger">
            {job.error?.message}
          </Typography>
        )}
        {insufficient && downloadable && (
          <Typography role="alert" variant="caption" tone="danger">
            {t("insufficientDisk", {
              required: formatBytes(required),
              available: formatBytes(free ?? 0),
            })}
          </Typography>
        )}
      </div>
    </Card>
  );
};
