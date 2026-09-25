import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Alert } from "../../shared/ui/Alert";
import { Spinner } from "../../shared/ui/Spinner";
import { Button, Progress, Select, TextField } from "../../theme/ui";
import { AlertTriangle, CheckCircle2, Cloud, Download } from "lucide-react";
import { useNotify } from "../../app/NotificationsProvider";
import type { ModelDto, ProcessingJobDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { pythonClient } from "../../services/pythonClient";
import { formatBytes } from "../../shared/utils/format";
import { canDownload, modelStateLabel, requiredDiskBytes } from "./aiModelModel";

const pollMilliseconds = 700;

export const AiSettings = () => {
  const t = useText();
  const notify = useNotify();
  const titleId = useId();
  const [models, setModels] = useState<readonly ModelDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [free, setFree] = useState<number | null>(null);
  const [jobs, setJobs] = useState<Readonly<Record<string, ProcessingJobDto>>>({});
  const [backend, setBackend] = useState<"Local" | "Kaggle">("Local");
  const [kaggleUrl, setKaggleUrl] = useState("");
  const [kaggleToken, setKaggleToken] = useState("");
  const [kaggleConfigured, setKaggleConfigured] = useState(false);
  const [savingBackend, setSavingBackend] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [list, diagnostics, ai] = await Promise.all([
        pythonClient.listModels(),
        pythonClient.diagnostics(),
        pythonClient.getAiProcessingSettings(),
      ]);
      if (!mounted.current) return;
      setModels(list);
      setFree(diagnostics.storage.free);
      setBackend(ai.processingBackend);
      setKaggleUrl(ai.kaggleUrl ?? "");
      setKaggleConfigured(ai.kaggleConfigured);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);

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
      while (mounted.current && ["queued", "processing", "cancelling"].includes(current.state)) {
        setJobs(items => ({ ...items, [model.id]: current }));
        await new Promise(resolve => window.setTimeout(resolve, pollMilliseconds));
        current = await pythonClient.getJob(job.id);
      }
      if (!mounted.current) return;
      setJobs(items => ({ ...items, [model.id]: current }));
      await refresh();
      if (current.state === "completed") notify(t("modelReady"), "success");
    },
    [notify, refresh, t]
  );

  const handleDownload = async (model: ModelDto) => {
    try {
      const job = await pythonClient.downloadModel(model);
      await track(model, job);
    } catch (error) {
      const message = error instanceof Object && "message" in error ? String(error.message) : t("modelDownloadFailed");
      notify(message, "error");
      await refresh();
    }
  };

  const handleCancel = async (jobId: string) => {
    await pythonClient.cancelJob(jobId);
  };

  const saveBackend = async () => {
    setSavingBackend(true);
    try {
      const updated = await pythonClient.updateAiProcessingSettings({
        processingBackend: backend,
        kaggleUrl: kaggleUrl.trim() || undefined,
        kaggleToken: kaggleToken.trim() || undefined,
      });
      setKaggleConfigured(updated.kaggleConfigured);
      setKaggleToken("");
      notify(t("aiBackendSaved"), "success");
    } catch (error) {
      notify(error instanceof Object && "message" in error ? String(error.message) : t("settingsApplyFailed"), "error");
    } finally {
      setSavingBackend(false);
    }
  };

  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId}>{t("aiProcessing")}</h2>
      <article className="settingCard aiBackendCard">
        <Cloud aria-hidden />
        <div className="settingCardContent aiBackendControls">
          <strong>{t("aiProcessingBackend")}</strong>
          <Select
            label={t("aiProcessingBackend")}
            value={backend}
            options={[
              { value: "Local", label: t("aiBackendLocal") },
              { value: "Kaggle", label: t("aiBackendKaggle") },
            ]}
            onChange={setBackend}
          />
          {backend === "Kaggle" && (
            <>
              <TextField fullWidth label={t("kaggleUrl")} value={kaggleUrl} onChange={setKaggleUrl} />
              <TextField
                fullWidth
                type="password"
                label={t("kaggleToken")}
                hint={kaggleConfigured ? t("kaggleTokenSaved") : t("kaggleTokenRequired")}
                value={kaggleToken}
                onChange={setKaggleToken}
              />
              <span>{t("kaggleBackendHint")}</span>
            </>
          )}
        </div>
        <Button
          size="sm"
          disabled={savingBackend || (backend === "Kaggle" && (!kaggleUrl.trim() || (!kaggleConfigured && !kaggleToken.trim())))}
          onClick={() => void saveBackend()}
        >
          {t("save")}
        </Button>
      </article>
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
      {backend === "Local" && models?.length === 0 && <p className="muted">{t("noModels")}</p>}
      {backend === "Local" && models?.map(model => {
        const job = jobs[model.id];
        const busy = model.state === "downloading" || (job && ["queued", "processing", "cancelling"].includes(job.state));
        const required = requiredDiskBytes(model);
        const insufficient = free !== null && free < required;
        const StatusIcon = model.state === "ready" ? CheckCircle2 : AlertTriangle;
        return (
          <article key={`${model.id}-${model.version}`} className="settingCard modelCard">
            <StatusIcon aria-hidden />
            <div className="settingCardContent">
              <strong>
                {model.id} · {model.purpose} · {model.version}
              </strong>
              <span>{t(modelStateLabel[model.state])}</span>
              {canDownload(model) && (
                <span className="muted">
                  {t("modelSizes", { download: formatBytes(model.sizeBytes), required: formatBytes(required) })}
                </span>
              )}
              {busy && <Progress aria-label={t("modelDownloading")} value={job?.progress ?? 0} />}
              {job?.state === "failed" && <span role="alert">{job.error?.message}</span>}
              {insufficient && canDownload(model) && (
                <span role="alert">
                  {t("insufficientDisk", { required: formatBytes(required), available: formatBytes(free ?? 0) })}
                </span>
              )}
            </div>
            {busy && job && (
              <Button size="sm" variant="outlined" tone="neutral" onClick={() => void handleCancel(job.id)}>
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
          </article>
        );
      })}
    </section>
  );
};
