import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useNotify } from "../../../../app/NotificationsProvider";
import type { KaggleActionDto } from "../../../../contracts/models";
import { useText } from "../../../../i18n/useText";
import { pythonClient } from "../../../../services/pythonClient";
import type { DisplayEntry } from "./secretsModel";

// One deployment at a time for the whole app: reopening the settings joins the running one.
type KaggleDeployment = {
  promise: Promise<KaggleActionDto>;
  startedAt: number;
};
let activeKaggleDeployment: KaggleDeployment | null = null;
const kaggleDeployment = (): KaggleDeployment => {
  if (activeKaggleDeployment) return activeKaggleDeployment;
  const deployment: KaggleDeployment = {
    promise: pythonClient.deployKaggle(),
    startedAt: Date.now(),
  };
  activeKaggleDeployment = deployment;
  void deployment.promise
    .finally(() => {
      if (activeKaggleDeployment === deployment) activeKaggleDeployment = null;
    })
    .catch(() => undefined);
  return deployment;
};

/** Whether a Kaggle deployment started earlier is still running. */
export const kaggleDeploymentRunning = (): boolean =>
  activeKaggleDeployment !== null;

/**
 * Signing in to Kaggle and deploying the processing server there, with the account's state shown on
 * the Kaggle entries and the time the deployment has been running.
 */
export const useKaggleActions = (
  setEntries: Dispatch<SetStateAction<DisplayEntry[] | null>>,
) => {
  const t = useText();
  const notify = useNotify();
  const [kaggleAction, setKaggleAction] = useState<"login" | "deploy" | null>(
    null,
  );
  const [kaggleElapsedSeconds, setKaggleElapsedSeconds] = useState(0);
  const [kaggleStartedAt, setKaggleStartedAt] = useState<number | null>(null);

  const verifyKaggle = useCallback(async () => {
    setEntries(
      (current) =>
        current?.map((item) =>
          item.group === "kaggle" && item.configured
            ? { ...item, state: "checking" }
            : item,
        ) ?? null,
    );
    const result = await pythonClient.verifyKaggleSettings();
    const verificationState = {
      valid: "valid",
      invalid: "unverified",
    } as const;
    setEntries(
      (current) =>
        current?.map((item) =>
          item.group === "kaggle" && item.configured
            ? {
                ...item,
                state: verificationState[result.state],
                message: result.message,
              }
            : item,
        ) ?? null,
    );
    return result;
  }, []);

  const runKaggleAction = useCallback(
    async (action: "login" | "deploy", announce = true) => {
      setKaggleAction(action);
      setEntries(
        (current) =>
          current?.map((entry) =>
            entry.group === "kaggle" && entry.configured
              ? { ...entry, state: "checking" }
              : entry,
          ) ?? null,
      );
      try {
        if (action === "login") {
          await pythonClient.loginKaggle();
          setKaggleAction("deploy");
        }
        const deployment = kaggleDeployment();
        setKaggleStartedAt(deployment.startedAt);
        const result = await deployment.promise;
        if (announce) notify(result.message, "success");
        await verifyKaggle();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t("settingsApplyFailed");
        setEntries(
          (current) =>
            current?.map((entry) =>
              entry.group === "kaggle" && entry.configured
                ? { ...entry, state: "invalid", message }
                : entry,
            ) ?? null,
        );
        notify(message, "error");
      } finally {
        setKaggleAction(null);
        setKaggleStartedAt(null);
      }
    },
    [notify, t, verifyKaggle],
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
