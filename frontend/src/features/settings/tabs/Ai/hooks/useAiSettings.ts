import { useState, useSyncExternalStore } from "react";
import { useNotify } from "../../../../../app/NotificationsProvider";
import type {
  ModelDto,
  ProcessingJobDto,
} from "../../../../../contracts/models";
import { useText } from "../../../../../i18n/useText";
import {
  useSettingsBackend,
  useSettingsDesktop,
  useSettingsJobEvents,
} from "../../../../../app/SettingsProvider";
import {
  aiSettingsSessionFor,
  type ProcessingBackend,
} from "../model/aiSettingsSession";

export type { ProcessingBackend } from "../model/aiSettingsSession";
const messageOf = (error: unknown, fallback: string) =>
  error instanceof Object && "message" in error
    ? String(error.message)
    : fallback;

/** The session owns the work; the hook subscribes and presents notifications. */
export const useAiSettings = () => {
  const backend = useSettingsBackend();
  const desktop = useSettingsDesktop();
  const events = useSettingsJobEvents();
  const notify = useNotify();
  const t = useText();
  const session = aiSettingsSessionFor(backend, desktop, events);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [transfer, setTransfer] = useState<{
    action: "export" | "import";
    progress: number;
  } | null>(null);
  const failures = [
    ...Object.values(state.errors),
    ...Object.values(state.downloadErrors),
  ];
  const reportError = (error: unknown) => {
    notify(messageOf(error, t("settingsApplyFailed")), "error");
  };

  return {
    ...state,
    transfer,
    transferLibrary: async (action: "export" | "import", file?: File) => {
      const path = file && desktop.pathForFile(file);
      if (transfer || (action === "import" && !path)) return;
      setTransfer({ action, progress: 0 });
      const progress = (job: ProcessingJobDto) =>
        setTransfer({ action, progress: job.progress ?? 0 });
      try {
        if (action === "export")
          await desktop.revealInExplorer(await backend.exportLibrary(progress));
        else
          notify(
            t("libraryImported", await backend.importLibrary(path!, progress)),
            "success",
          );
      } catch (error) {
        notify(messageOf(error, t("libraryTransferFailed")), "error");
      } finally {
        setTransfer(null);
      }
    },
    failed: failures.length > 0,
    error: failures.length
      ? messageOf(failures[0], t("modelsLoadFailed"))
      : null,
    loadingModels: state.models === null && !("models" in state.errors),
    refresh: session.refresh,
    download: async (model: ModelDto) => {
      try {
        if ((await session.start(model)).state === "completed")
          notify(t("modelReady"), "success");
      } catch (error) {
        notify(messageOf(error, t("modelDownloadFailed")), "error");
      }
    },
    cancel: (jobId: string) => session.cancel(jobId).catch(reportError),
    changeBackend: async (next: ProcessingBackend) => {
      try {
        if (await session.changeBackend(next))
          notify(t("aiBackendSaved"), "success");
      } catch (error) {
        reportError(error);
      }
    },
    chooseDataRoot: () => session.chooseDataRoot().catch(reportError),
  };
};
