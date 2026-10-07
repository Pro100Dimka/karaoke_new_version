import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotify } from "../../../../app/NotificationsProvider";
import { useSettingsBackend } from "../../../../app/SettingsProvider";
import { kaggleDeploymentRunning } from "../../../../application/settings/KaggleDeployment";
import { useText } from "../../../../i18n/useText";
import {
  isSecret,
  saveDelayMilliseconds,
  valuesOf,
  type DisplayEntry,
} from "./secretsModel";
import { useKaggleActions } from "./useKaggleActions";

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
/** The Kaggle token is verified through the notebook itself, every other key on its own. */
const verifiesAlone = (key: string) => key !== "KAGGLE_API_TOKEN";

/**
 * ENV entries with their verification state. Every edit is saved after a short pause and then
 * verified; the technical JSON is derived from the same entries and can be applied back.
 */
export const useEnvironmentSettings = () => {
  const backend = useSettingsBackend();
  const t = useText();
  const notify = useNotify();
  const [entries, setEntries] = useState<DisplayEntry[] | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const timers = useRef(new Map<string, number>());
  const kaggle = useKaggleActions(setEntries);
  const { runKaggleAction, verifyKaggle } = kaggle;

  const update = useCallback(
    (key: string, change: (entry: DisplayEntry) => DisplayEntry) =>
      setEntries(
        (current) =>
          current?.map((entry) =>
            entry.key === key ? change(entry) : entry,
          ) ?? null,
      ),
    [],
  );
  /**
   * Applies a server answer unless the user has typed something newer. Typed text stays as it is,
   * except a saved secret: the server never returns it, so its field empties to the "saved" state.
   */
  const replace = useCallback(
    (next: DisplayEntry, expectedValue = next.value) =>
      update(next.key, (entry) =>
        entry.value === expectedValue
          ? { ...next, value: isSecret(next) ? "" : entry.value }
          : entry,
      ),
    [update],
  );

  useEffect(() => {
    let active = true;
    void Promise.all([
      backend.listEnvironmentSettings(),
      backend.getAiProcessingSettings(),
    ])
      .then(([environment, settings]) => {
        if (!active) return;
        setEntries([...environment]);
        for (const entry of environment.filter(
          (item) => verifiesAlone(item.key) && item.configured,
        ))
          void backend
            .verifyEnvironmentSetting(entry.key)
            .then((result) => active && replace(result, entry.value))
            .catch(() => undefined);
        if (kaggleDeploymentRunning()) {
          void runKaggleAction("deploy", false);
          return;
        }
        const account = environment.find(
          (entry) => entry.key === "KAGGLE_API_TOKEN",
        );
        if (
          account?.configured &&
          settings.processingBackend === "Kaggle" &&
          settings.kaggleConfigured
        )
          void verifyKaggle().catch(() => undefined);
      })
      .catch((error) =>
        notify(errorText(error, t("settingsApplyFailed")), "error"),
      );
    return () => {
      active = false;
    };
  }, [notify, replace, runKaggleAction, t, verifyKaggle]);

  const save = useCallback(
    async (key: string, value: string) => {
      const trimmed = value.trim();
      update(key, (entry) => ({
        ...entry,
        value,
        configured: Boolean(trimmed),
        state: trimmed ? "checking" : "empty",
        message: t(trimmed ? "checking" : "environmentNotConfigured"),
      }));
      try {
        const stored = await backend.updateEnvironmentSetting(key, value);
        const verify =
          verifiesAlone(key) && stored.configured && stored.state !== "invalid";
        replace(
          { ...stored, state: verify ? "checking" : stored.state },
          value,
        );
        if (verify)
          replace(
            await backend.verifyEnvironmentSetting(key),
            isSecret(stored) ? "" : value,
          );
      } catch (error) {
        notify(errorText(error, t("settingsApplyFailed")), "error");
        update(key, (entry) =>
          entry.value === value
            ? { ...entry, state: "invalid", message: t("settingsApplyFailed") }
            : entry,
        );
      }
    },
    [notify, replace, t, update],
  );

  const change = useCallback(
    (key: string, value: string) => {
      const previous = timers.current.get(key);
      if (previous !== undefined) window.clearTimeout(previous);
      timers.current.delete(key);
      // An emptied secret field means "keep the saved one"; removing it is an explicit action.
      if (
        !value.trim() &&
        entriesRef.current?.some(
          (entry) => entry.key === key && isSecret(entry),
        )
      ) {
        update(key, (entry) => ({ ...entry, value }));
        return;
      }
      const configured = Boolean(value.trim());
      update(key, (entry) => ({
        ...entry,
        value,
        configured,
        state: configured ? "unverified" : "empty",
        message: t(
          configured ? "environmentSaved" : "environmentNotConfigured",
        ),
      }));
      timers.current.set(
        key,
        window.setTimeout(() => {
          timers.current.delete(key);
          void save(key, value);
        }, saveDelayMilliseconds),
      );
    },
    [save, t, update],
  );

  const json = useMemo(() => valuesOf(entries ?? []), [entries]);

  /** Applies an edited JSON object; only known keys with string values are accepted. */
  const applyJson = useCallback(
    async (source: string) => {
      const parsed: unknown = JSON.parse(source);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("JSON must contain an object");
      const known = new Set(Object.keys(json));
      const invalid = Object.entries(parsed).find(
        ([key, value]) => !known.has(key) || typeof value !== "string",
      );
      if (invalid) throw new Error(`Unsupported ENV value: ${invalid[0]}`);
      const changes = Object.entries(parsed as Record<string, string>).filter(
        ([key, value]) => json[key] !== value,
      );
      // Every new value shows at once; the saves then run one after another.
      for (const [key, value] of changes)
        update(key, (entry) => ({
          ...entry,
          value,
          configured: Boolean(value.trim()),
          state: value.trim() ? "unverified" : "empty",
        }));
      for (const [key, value] of changes) await save(key, value);
    },
    [json, save, update],
  );

  return { entries, json, change, save, applyJson, kaggle };
};
