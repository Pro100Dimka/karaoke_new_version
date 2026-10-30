import { tr, useLocale } from "@neo-ui-kit/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNotify } from "../../../../../providers/notifications";
import { ru } from "../../../../../i18n/messages.ru";
import { pythonClient } from "../../../../../services/pythonClient";
import { environmentStoreFor } from "./environmentStore";
import { valuesOf, isSecret, saveDelayMilliseconds } from "./environmentModel";

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** Drafts belong to this view; submitted writes and verification survive its closure. */
export const useEnvironmentSettings = () => {
  const store = environmentStoreFor(pythonClient);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useLocale();
  const notify = useNotify();
  const [now, setNow] = useState(Date.now);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const pending = useRef(new Map<string, { value: string; timer: ReturnType<typeof setTimeout> }>());
  const reportError = (error: unknown) => notify(errorText(error, tr(ru.settingsApplyFailed)), "error");
  const reportErrorRef = useRef(reportError);
  reportErrorRef.current = reportError;
  const discard = (key: string) => {
    clearTimeout(pending.current.get(key)?.timer);
    pending.current.delete(key);
    setDrafts(current => { const next = { ...current }; delete next[key]; return next; });
  };
  const flush = () => {
    const writes = [...pending.current];
    pending.current.clear();
    setDrafts(current => { const next = { ...current }; for (const [key] of writes) delete next[key]; return next; });
    return Promise.all(writes.map(([key, { value, timer }]) => {
      clearTimeout(timer);
      return store.save(key, value);
    }));
  };
  useEffect(() => {
    const writes = pending.current;
    return () => {
      for (const [key, { value, timer }] of writes) {
        clearTimeout(timer);
        void store.save(key, value).catch(error => reportErrorRef.current(error));
      }
      writes.clear();
    };
  }, [store]);
  const change = (key: string, value: string) => {
    discard(key);
    const entry = snapshot.entries?.find(entry => entry.key === key);
    if (entry && isSecret(entry) && !value.trim()) { store.cancelPending(key); return; }
    setDrafts(current => ({ ...current, [key]: value }));
    const timer = setTimeout(() => {
      pending.current.delete(key);
      void store.save(key, value).catch(error => reportErrorRef.current(error));
      setDrafts(current => { const next = { ...current }; delete next[key]; return next; });
    }, saveDelayMilliseconds);
    pending.current.set(key, { value, timer });
  };
  const entries = snapshot.entries?.map(entry => {
    const value = drafts[entry.key];
    return value === undefined ? entry : { ...entry, value,
      state: value.trim() ? "unverified" as const : "empty" as const, errorMessage: undefined };
  }) ?? null;

  useEffect(() => {
    void store.load();
  }, [store]);
  useEffect(() => {
    if (snapshot.kaggleStartedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot.kaggleStartedAt]);

  const save = async (key: string, value: string) => {
    discard(key);
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
      await flush();
      notify(await store.runKaggleAction(action), "success");
    } catch (error) {
      reportError(error);
    }
  };

  return {
    entries,
    loadError: snapshot.loadError
      ? errorText(snapshot.loadError, tr(ru.actionFailed))
      : null,
    retry: () => void store.load(),
    json: valuesOf(entries ?? []),
    change,
    save,
    applyJson: async (source: string) => {
      await flush();
      await store.applyJson(source);
    },
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
