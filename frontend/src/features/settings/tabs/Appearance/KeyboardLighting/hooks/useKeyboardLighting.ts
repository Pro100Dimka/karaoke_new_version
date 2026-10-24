import { useEffect, useRef, useState } from "react";
import { useApp } from "../../../../../../app/AppContext";
import { useNotify } from "../../../../../../app/NotificationsProvider";
import { useText } from "../../../../../../i18n/useText";
import { useSettingsLighting } from "../../../../../../app/SettingsProvider";

/** Discover devices while this view is open and apply edits to the saved lighting settings. */
export const useKeyboardLighting = () => {
  const { preferences, updatePreferences } = useApp("preferences");
  const notify = useNotify();
  const t = useText();
  const service = useSettingsLighting();
  const [capabilities, setCapabilities] =
    useState<Awaited<ReturnType<typeof service.capabilities>>>();
  const lighting = preferences.keyboardLighting;
  const requested = useRef(lighting);
  useEffect(() => {
    requested.current = lighting;
  }, [lighting]);

  useEffect(() => {
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
  }, [service]);

  const update = (patch: Partial<typeof lighting>) => {
    const next = { ...requested.current, ...patch };
    requested.current = next;
    updatePreferences({ keyboardLighting: next });
    void service
      .apply(next, preferences.theme)
      .catch((error: unknown) =>
        notify(
          `${t("settingsApplyFailed")}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        ),
      );
  };

  return { lighting, capabilities, update };
};
