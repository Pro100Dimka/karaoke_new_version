import { useCallback, useEffect, useRef, useState } from "react";
import { useNotify } from "../../../../app/NotificationsProvider";
import type { AiProcessingSettingsDto, ModelDto, ProcessingJobDto } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import {
  useSettingsBackend, useSettingsDesktop, useSettingsJobEvents,
} from "../../../../app/SettingsProvider";

const pollMilliseconds = 700;
const activeJobStates = new Set<ProcessingJobDto["state"]>([
  "queued",
  "processing",
  "cancelling",
]);
export type ProcessingBackend = AiProcessingSettingsDto["processingBackend"];

export const isJobActive = (job: ProcessingJobDto | undefined) =>
  Boolean(job && activeJobStates.has(job.state));
const messageOf = (error: unknown, fallback: string) =>
  error instanceof Object && "message" in error
    ? String(error.message)
    : fallback;

/** Models, their download jobs, free space, the processing backend and the data folder of the AI tab. */
export const useAiSettings = () => {
  const backendService = useSettingsBackend();
  const desktop = useSettingsDesktop();
  const jobEvents = useSettingsJobEvents();
  const t = useText();
  const notify = useNotify();
  const [models, setModels] = useState<readonly ModelDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [free, setFree] = useState<number | null>(null);
  const [jobs, setJobs] = useState<Readonly<Record<string, ProcessingJobDto>>>(
    {},
  );
  const [backend, setBackend] = useState<ProcessingBackend>("Local");
  const [savingBackend, setSavingBackend] = useState(false);
  const [dataRoot, setDataRoot] = useState("");
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [list, diagnostics, ai, root] = await Promise.all([
        backendService.listModels(),
        backendService.diagnostics(),
        backendService.getAiProcessingSettings(),
        desktop.getStorageRoot(),
      ]);
      if (!mounted.current) return;
      setModels(list);
      setFree(diagnostics.storage.free);
      setBackend(ai.processingBackend);
      setDataRoot(root);
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
      // Listening starts before each read, so a change that lands during the read is not missed.
      let changed = jobEvents.next(job.id, pollMilliseconds);
      while (mounted.current && activeJobStates.has(current.state)) {
        setJobs((items) => ({ ...items, [model.id]: current }));
        await changed;
        changed = jobEvents.next(job.id, pollMilliseconds);
        current = await backendService.getJob(job.id);
      }
      if (!mounted.current) return;
      setJobs((items) => ({ ...items, [model.id]: current }));
      await refresh();
      if (current.state === "completed") notify(t("modelReady"), "success");
    },
    [notify, refresh, t],
  );

  const download = async (model: ModelDto) => {
    try {
      await track(model, await backendService.downloadModel(model));
    } catch (error) {
      notify(messageOf(error, t("modelDownloadFailed")), "error");
      await refresh();
    }
  };

  const cancel = (jobId: string) => void backendService.cancelJob(jobId);

  const changeBackend = async (next: ProcessingBackend) => {
    const previous = backend;
    setBackend(next);
    setSavingBackend(true);
    try {
      await backendService.updateAiProcessingSettings({
        processingBackend: next,
      });
      notify(t("aiBackendSaved"), "success");
    } catch (error) {
      setBackend(previous);
      notify(messageOf(error, t("settingsApplyFailed")), "error");
    } finally {
      setSavingBackend(false);
    }
  };

  const chooseDataRoot = async () => {
    try {
      const picked = await desktop.pickStorageFolder();
      if (!picked) return;
      await desktop.setStorageRoot(picked);
      setDataRoot(picked);
    } catch (error) {
      notify(messageOf(error, t("settingsApplyFailed")), "error");
    }
  };

  return {
    models,
    failed,
    free,
    jobs,
    backend,
    savingBackend,
    dataRoot,
    refresh,
    download,
    cancel,
    changeBackend,
    chooseDataRoot,
  };
};
