import { useEffect, useRef } from "react";
import { useNotify } from "./NotificationsProvider";
import { useServices } from "./ServicesContext";
import { hasEditorDraft } from "../features/editor/editorDraft";
import { useText } from "../i18n/useText";
import { pythonClient } from "../services/pythonClient";

/** Once per launch, surfaces items left unresolved by a previous crash; nothing is auto-resumed. */
export const StartupRecovery = () => {
  const { python } = useServices();
  const notify = useNotify();
  const t = useText();
  const done = useRef(false);

  useEffect(() => {
    if (python.kind !== "ready" || done.current) return;
    done.current = true;
    void pythonClient
      .listJobs()
      .then(jobs => {
        if (jobs.some(job => job.state === "interrupted")) notify(t("recoveryInterruptedJobs"), "warning");
      })
      .catch(() => undefined);
    if (hasEditorDraft()) notify(t("recoveryEditorDraft"), "warning");
  }, [python.kind, notify, t]);

  return null;
};
