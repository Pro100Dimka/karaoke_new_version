import { useEffect, useState, useSyncExternalStore } from "react";
import { useNotify } from "../../../../../app/NotificationsProvider";
import { useText } from "../../../../../i18n/useText";
import { useSettingsBackend } from "../../../../../app/SettingsProvider";
import { environmentStoreFor } from "../model/environmentStore";
import { valuesOf } from "../model/environmentModel";

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** The session owns settings work; this hook only subscribes and presents its outcome. */
export const useEnvironmentSettings = () => {
  const store = environmentStoreFor(useSettingsBackend());
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const t = useText();
  const notify = useNotify();
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    void store.load();
  }, [store]);
  useEffect(() => {
    if (snapshot.kaggleStartedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.kaggleStartedAt]);

  const reportError = (error: unknown) => {
    notify(errorText(error, t("settingsApplyFailed")), "error");
  };
  const save = async (key: string, value: string) => {
    try {
      await store.save(key, value);
    } catch (error) {
      reportError(error);
    }
  };
  const runKaggleAction = async (
    action: Parameters<typeof store.runKaggleAction>[0],
  ) => {
    try {
      notify(await store.runKaggleAction(action), "success");
    } catch (error) {
      reportError(error);
    }
  };

  return {
    entries: snapshot.entries,
    loadError: snapshot.loadError
      ? errorText(snapshot.loadError, t("actionFailed"))
      : null,
    retry: () => void store.load(),
    json: valuesOf(snapshot.entries ?? []),
    change: (key: string, value: string) =>
      store.change(key, value, reportError),
    save,
    applyJson: store.applyJson,
    kaggle: {
      kaggleAction: snapshot.kaggleAction,
      kaggleElapsedSeconds:
        snapshot.kaggleStartedAt === null
          ? 0
          : Math.max(0, Math.floor((now - snapshot.kaggleStartedAt) / 1000)),
      runKaggleAction,
      verifyKaggle: store.verifyKaggle,
    },
  };
};

export type KaggleSettings = ReturnType<
  typeof useEnvironmentSettings
>["kaggle"];
