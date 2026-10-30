import { tr, useLocale } from "@neo-ui-kit/react";
import { useEffect, useState } from "react";
import { version as frontendVersion } from "../../../../../../../package.json";
import { useNotify } from "../../../../../../providers/notifications";
import { ru } from "../../../../../../i18n/messages.ru";
import { pythonClient as backend } from "../../../../../../services/pythonClient";
import { desktopClient as desktop } from "../../../../../../services/desktopClient";
import type { SubsystemHealth } from "../useSubsystemHealth";
import { buildDiagnosticsReport } from "./diagnosticsReport";

/** Reports read current job failures on demand; lighting discovery lasts while the view is open. */
export const useDiagnosticsActions = (health: SubsystemHealth) => {
  const notify = useNotify();
  useLocale();
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
        tr(ru[destination === "clipboard" ? "copied" : "reportExported"]),
        "success",
      );
    } catch (error) {
      notify(
        error instanceof Error ? error.message : tr(ru.settingsApplyFailed),
        "error",
      );
    }
  };

  return { lighting, deliverReport };
};
