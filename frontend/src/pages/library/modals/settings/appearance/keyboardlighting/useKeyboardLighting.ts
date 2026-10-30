import { store } from "../../../../../../providers/store";
import { tr, useLocale } from "@neo-ui-kit/react";
import { useEffect, useRef, useState } from "react";
import { useNotify } from "../../../../../../providers/notifications";
import { ru } from "../../../../../../i18n/messages.ru";
import { keyboardLightingClient as service } from "../../../../../../services/keyboardLightingClient";

/** Discover devices while this view is open and apply edits to the saved lighting settings. */
export const useKeyboardLighting = (enabled = true) => {
  const { preferences, updatePreferences } = store;
  const notify = useNotify();
  useLocale();
  const [capabilities, setCapabilities] =
    useState<Awaited<ReturnType<typeof service.capabilities>>>();
  const lighting = preferences.keyboardLighting;
  const requested = useRef(lighting);
  useEffect(() => {
    requested.current = lighting;
  }, [lighting]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const value = await service.capabilities();
        if (active) setCapabilities(value);
      } catch {
        // Optional discovery keeps the last result and retries without overlapping requests.
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 5000);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [service, enabled]);

  const update = (patch: Partial<typeof lighting>) => {
    const next = { ...requested.current, ...patch };
    requested.current = next;
    updatePreferences({ keyboardLighting: next });
    void service
      .apply(next, preferences.theme)
      .catch((error: unknown) =>
        notify(
          `${tr(ru.settingsApplyFailed)}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        ),
      );
  };

  return { lighting, capabilities, update };
};
