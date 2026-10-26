import {
  Button,
  Card,
  ProgressBar,
  StatusIndicator,
  Typography,
  tr,
} from "@neo-ui-kit/react";
import type {
  ModelDto,
  ProcessingJobDto,
} from "../../../../../contracts/models";
import type { MessageKey } from "../../../../../i18n/messages";
import { useText } from "../../../../../i18n/useText";
import { formatBytes } from "../../../../../shared/utils/format";
import { isJobActive } from "../model/aiSettingsSession";

const modelStateLabel = {
  "not-installed": "modelNotInstalled",
  downloading: "modelDownloading",
  ready: "modelReady",
  failed: "modelFailed",
  "update-available": "modelUpdateAvailable",
} as const satisfies Record<ModelDto["state"], MessageKey>;

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
  pending = false,
  free,
  onDownload,
  onCancel,
  onDelete,
}: {
  model: ModelDto;
  job?: ProcessingJobDto;
  pending?: boolean;
  free: number | null;
  onDownload(model: ModelDto): void;
  onCancel(jobId: string): void;
  onDelete(model: ModelDto): void;
}) => {
  const t = useText();
  const activeJob = isJobActive(job) ? job : undefined;
  const busy = pending || model.state === "downloading" || Boolean(activeJob);
  const downloadable = ["not-installed", "failed", "update-available"].includes(
    model.state,
  );
  // Payload, temporary copy and a 10% margin.
  const required = Math.ceil(model.sizeBytes * 2.1);
  const insufficient = free !== null && free < required;
  const action = () => {
    if (activeJob)
      return (
        <Button
          size="sm"
          variant="ghost"
          icon="close"
          onClick={() => onCancel(activeJob.id)}
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
    return model.state === "ready" ? (
      <Button size="sm" variant="ghost" icon="trash" disabled={busy} onClick={() => onDelete(model)}>
        {tr("Удалить модель")}
      </Button>
    ) : null;
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
            label={activeJob?.stage === "Verify" ? tr("Проверка скачанного файла…") : t("modelDownloading")}
            indeterminate={!activeJob}
            value={activeJob?.progress ?? 0}
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
