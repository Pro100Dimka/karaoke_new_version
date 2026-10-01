import {
  AlertTriangle,
  AudioLines,
  Box,
  CheckCircle2,
  ChevronRight,
  Download,
  Microchip,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNotify } from "../../../../app/NotificationsProvider";
import type { ModelDto, ProcessingJobDto } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { desktopClient } from "../../../../services/desktopClient";
import { pythonClient } from "../../../../services/pythonClient";
import { Alert } from "../../../../shared/ui/Alert";
import { Spinner } from "../../../../shared/ui/Spinner";
import { formatBytes } from "../../../../shared/utils/format";
import { SettingsCard } from "../../SettingsCard";
import { SettingsWaves } from "../Advanced/Artwork";
import {
  Button,
  Progress,
  RenderFormikFields,
  Select,
  useGetForm,
} from "../../../../theme/ui";
import {
  canDownload,
  modelStateLabel,
  requiredDiskBytes,
} from "./aiModelModel";
import "./ai.css";

const pollMilliseconds = 700;

export const AiSettings = () => {
  const t = useText();
  const notify = useNotify();
  const [models, setModels] = useState<readonly ModelDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [free, setFree] = useState<number | null>(null);
  const [jobs, setJobs] = useState<Readonly<Record<string, ProcessingJobDto>>>(
    {},
  );
  const [backend, setBackend] = useState<"Local" | "Kaggle">("Local");
  const [savingBackend, setSavingBackend] = useState(false);
  const mounted = useRef(true);
  const storageForm = useGetForm({
    initialValues: { dataRoot: "" },
    onSubmit: () => undefined,
  });

  const refresh = useCallback(async () => {
    try {
      const [list, diagnostics, ai, dataRoot] = await Promise.all([
        pythonClient.listModels(),
        pythonClient.diagnostics(),
        pythonClient.getAiProcessingSettings(),
        desktopClient.getStorageRoot(),
      ]);
      if (!mounted.current) return;
      setModels(list);
      setFree(diagnostics.storage.free);
      setBackend(ai.processingBackend);
      await storageForm.setFieldValue("dataRoot", dataRoot, false);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, [storageForm.setFieldValue]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const track = useCallback(
    async (model: ModelDto, job: ProcessingJobDto) => {
      let current = job;
      while (
        mounted.current &&
        ["queued", "processing", "cancelling"].includes(current.state)
      ) {
        setJobs((items) => ({ ...items, [model.id]: current }));
        await new Promise((resolve) =>
          window.setTimeout(resolve, pollMilliseconds),
        );
        current = await pythonClient.getJob(job.id);
      }
      if (!mounted.current) return;
      setJobs((items) => ({ ...items, [model.id]: current }));
      await refresh();
      if (current.state === "completed") notify(t("modelReady"), "success");
    },
    [notify, refresh, t],
  );

  const handleDownload = async (model: ModelDto) => {
    try {
      const job = await pythonClient.downloadModel(model);
      await track(model, job);
    } catch (error) {
      const message =
        error instanceof Object && "message" in error
          ? String(error.message)
          : t("modelDownloadFailed");
      notify(message, "error");
      await refresh();
    }
  };

  const handleCancel = async (jobId: string) => {
    await pythonClient.cancelJob(jobId);
  };

  const changeBackend = async (next: "Local" | "Kaggle") => {
    const previous = backend;
    setBackend(next);
    setSavingBackend(true);
    try {
      await pythonClient.updateAiProcessingSettings({
        processingBackend: next,
      });
      notify(t("aiBackendSaved"), "success");
    } catch (error) {
      setBackend(previous);
      notify(
        error instanceof Object && "message" in error
          ? String(error.message)
          : t("settingsApplyFailed"),
        "error",
      );
    } finally {
      setSavingBackend(false);
    }
  };

  return (
    <SettingsCard
      icon={Microchip}
      title={t("aiSettingsTitle")}
      description={t("aiSettingsHint")}
      className="aiShellCard"
    >
      <span className="aiHeaderWave" aria-hidden><SettingsWaves kind="about" /></span>
      <span className="aiPromise" aria-hidden>{t("aiSettingsPromise")}</span>
      <div className="aiBackendControls">
        <Select
          label={t("aiProcessingBackend")}
          value={backend}
          options={[
            { value: "Local", label: t("aiBackendLocal") },
            { value: "Kaggle", label: t("aiBackendKaggle") },
          ]}
          disabled={savingBackend}
          onChange={(value) => void changeBackend(value)}
        />
        <RenderFormikFields
          formik={storageForm}
          pickFolder={desktopClient.pickStorageFolder}
          onFieldCommit={async (name, value) => {
            if (name === "dataRoot")
              await desktopClient.setStorageRoot(String(value));
          }}
          items={[
            {
              type: "FolderField",
              tag: "dataRoot",
              label: t("dataStorageRoot"),
              browseLabel: t("selectDataFolder"),
              hint: t("dataStorageRootHint"),
              md: 12,
            },
          ]}
        />
      </div>
      {failed && (
        <Alert
          intent="error"
          actions={
            <Button size="sm" onClick={() => void refresh()}>
              {t("retry")}
            </Button>
          }
        >
          {t("modelsLoadFailed")}
        </Alert>
      )}
      {!models && !failed && <Spinner label={t("loadingSettings")} />}
      {backend === "Local" && models?.length === 0 && (
        <p className="muted">{t("noModels")}</p>
      )}
      <div className="aiModels">
        {backend === "Local" &&
          models?.map((model) => {
            const job = jobs[model.id];
            const busy =
              model.state === "downloading" ||
              (job &&
                ["queued", "processing", "cancelling"].includes(job.state));
            const required = requiredDiskBytes(model);
            const insufficient = free !== null && free < required;
            const StatusIcon =
              model.state === "ready" ? CheckCircle2 : AlertTriangle;
            const ModelIcon = model.purpose === "Separation" ? Box : AudioLines;
            return (
              <article
                key={`${model.id}-${model.version}`}
                className="modelCard"
              >
                <ModelIcon className="modelCardIcon" aria-hidden />
                <div className="settingCardContent">
                  <strong>
                    {model.purpose} ({model.id})
                  </strong>
                  <span className="modelCardState">
                    <StatusIcon aria-hidden />
                    {t(modelStateLabel[model.state])}
                  </span>
                  {canDownload(model) && (
                    <span className="muted">
                      {t("modelSizes", {
                        download: formatBytes(model.sizeBytes),
                        required: formatBytes(required),
                      })}
                    </span>
                  )}
                  {busy && (
                    <Progress
                      aria-label={t("modelDownloading")}
                      value={job?.progress ?? 0}
                    />
                  )}
                  {job?.state === "failed" && (
                    <span role="alert">{job.error?.message}</span>
                  )}
                  {insufficient && canDownload(model) && (
                    <span role="alert">
                      {t("insufficientDisk", {
                        required: formatBytes(required),
                        available: formatBytes(free ?? 0),
                      })}
                    </span>
                  )}
                </div>
                {busy && job && (
                  <Button
                    size="sm"
                    variant="outlined"
                    tone="neutral"
                    onClick={() => void handleCancel(job.id)}
                  >
                    {t("cancel")}
                  </Button>
                )}
                {!busy && canDownload(model) && (
                  <Button
                    size="sm"
                    startIcon={<Download size={15} />}
                    disabled={insufficient}
                    onClick={() => void handleDownload(model)}
                  >
                    {model.state === "failed" ? t("retry") : t("download")}
                  </Button>
                )}
                {!busy && !canDownload(model) && (
                  <ChevronRight className="modelCardChevron" aria-hidden />
                )}
              </article>
            );
          })}
      </div>
    </SettingsCard>
  );
};
