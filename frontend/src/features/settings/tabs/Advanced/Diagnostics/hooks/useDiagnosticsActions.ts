import { useEffect, useState } from "react";
import { version as frontendVersion } from "../../../../../../../package.json";
import { useNotify } from "../../../../../../app/NotificationsProvider";
import { useText } from "../../../../../../i18n/useText";
import {
  useSettingsBackend,
  useSettingsDesktop,
} from "../../../../SettingsProvider";
import type { SubsystemHealth } from "../../hooks/useSubsystemHealth";
import { buildDiagnosticsReport } from "../model/diagnosticsReport";

/** Reports read current job failures on demand; lighting discovery lasts while the view is open. */
export const useDiagnosticsActions = (health: SubsystemHealth) => {
  const desktop = useSettingsDesktop();
  const backend = useSettingsBackend();
  const notify = useNotify();
  const t = useText();
  const [lighting, setLighting] = useState<KeyboardLightingCapabilities>({
    available: false,
    deviceCount: 0,
  });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const value = await desktop.keyboardLightingCapabilities();
        if (active) setLighting(value);
      } catch {
        if (active) setLighting({ available: false, deviceCount: 0 });
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 5000);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [desktop]);

  const deliverReport = async (destination: "clipboard" | "file") => {
    try {
      const text = buildDiagnosticsReport({
        frontendVersion,
        generatedAt: new Date().toISOString(),
        backend: health.backend,
        audio: health.audio,
        keyboardLighting: lighting.available,
        jobs: await backend.listJobs().catch(() => null),
      });
      if (destination === "clipboard") await desktop.copyText(text);
      else if (!(await desktop.saveTextFile("ad-voice-diagnostics.json", text)))
        return;
      notify(
        t(destination === "clipboard" ? "copied" : "reportExported"),
        "success",
      );
    } catch (error) {
      notify(
        error instanceof Error ? error.message : t("settingsApplyFailed"),
        "error",
      );
    }
  };

  return { lighting, deliverReport };
};
