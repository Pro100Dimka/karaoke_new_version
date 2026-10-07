import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useNotify } from "../../../../app/NotificationsProvider";
import { useSettingsBackend } from "../../../../app/SettingsProvider";
import { kaggleDeployment } from "../../../../application/settings/KaggleDeployment";
import { useText } from "../../../../i18n/useText";
import type { DisplayEntry } from "./secretsModel";

/**
 * Signing in to Kaggle and deploying the processing server there, with the account's state shown on
 * the Kaggle entries and the time the deployment has been running.
 */
export const useKaggleActions = (
  setEntries: Dispatch<SetStateAction<DisplayEntry[] | null>>,
) => {
  const backend = useSettingsBackend();
  const t = useText();
  const notify = useNotify();
  const [kaggleAction, setKaggleAction] = useState<"login" | "deploy" | null>(
    null,
  );
  const [kaggleElapsedSeconds, setKaggleElapsedSeconds] = useState(0);
  const [kaggleStartedAt, setKaggleStartedAt] = useState<number | null>(null);

  const updateKaggleEntries = useCallback(
    (change: (entry: DisplayEntry) => DisplayEntry) =>
      setEntries(
        (current) =>
          current?.map((entry) =>
            entry.group === "kaggle" && entry.configured
              ? change(entry)
              : entry,
          ) ?? null,
      ),
    [setEntries],
  );

  const verifyKaggle = useCallback(async () => {
    updateKaggleEntries((entry) => ({ ...entry, state: "checking" }));
    const result = await backend.verifyKaggleSettings();
    const verificationState = {
      valid: "valid",
      invalid: "unverified",
    } as const;
    updateKaggleEntries((entry) => ({
      ...entry,
      state: verificationState[result.state],
      message: result.message,
    }));
    return result;
  }, [updateKaggleEntries]);

  const runKaggleAction = useCallback(
    async (action: "login" | "deploy", announce = true) => {
      setKaggleAction(action);
      updateKaggleEntries((entry) => ({ ...entry, state: "checking" }));
      try {
        if (action === "login") {
          await backend.loginKaggle();
          setKaggleAction("deploy");
        }
        const deployment = kaggleDeployment(backend);
        setKaggleStartedAt(deployment.startedAt);
        const result = await deployment.promise;
        if (announce) notify(result.message, "success");
        await verifyKaggle();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t("settingsApplyFailed");
        updateKaggleEntries((entry) => ({ ...entry, state: "invalid", message }));
        notify(message, "error");
      } finally {
        setKaggleAction(null);
        setKaggleStartedAt(null);
      }
    },
    [notify, t, updateKaggleEntries, verifyKaggle],
  );

  useEffect(() => {
    if (kaggleAction !== "deploy" || kaggleStartedAt === null) return;
    const updateElapsed = () =>
      setKaggleElapsedSeconds(
        Math.floor((Date.now() - kaggleStartedAt) / 1000),
      );
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [kaggleAction, kaggleStartedAt]);

  return { kaggleAction, kaggleElapsedSeconds, verifyKaggle, runKaggleAction };
};
