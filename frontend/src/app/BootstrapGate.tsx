import { useEffect, useState, type ReactNode } from "react";
import { useText } from "../i18n/useText";
import { audioClient } from "../services/audioClient";
import { desktopClient } from "../services/desktopClient";
import { Button, EmptyState } from "@ad-voice/ui";
import { useApp } from "./AppContext";
import { expectedPythonApiVersion } from "./serviceStatus";
import { useServices } from "./ServicesContext";
import { useVoiceChain } from "../features/karaoke/console/voiceChain";
import { useAcousticLatencyAutoSave } from "./useAcousticLatencyAutoSave";

/**
 * Holds the interface until the backend status is known so no control is usable before its service is.
 * AudioService trouble never blocks the offline Library; it only disables live-audio features later.
 */
export const BootstrapGate = ({ children }: { children: ReactNode }) => {
  const { python, probe } = useServices();
  const { preferences } = useApp("preferences");
  const t = useText();
  const [admitted, setAdmitted] = useState(false);

  useEffect(() => {
    audioClient.setPreferredConfiguration(preferences.audio);
  }, [preferences.audio]);

  useAcousticLatencyAutoSave();
  useVoiceChain();

  useEffect(() => {
    if (python.kind === "ready") setAdmitted(true);
  }, [python.kind]);

  // The window stays hidden until the app (or its error screen) has painted two frames behind the splash.
  useEffect(() => {
    if (python.kind === "starting" || (python.kind === "ready" && !admitted))
      return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(
        () => void desktopClient.appReady(),
      );
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [python.kind, admitted]);

  if (admitted) return <>{children}</>;

  if (python.kind === "starting") {
    return null;
  }

  return (
    <main className="bootstrapState" role="alert">
      <EmptyState
        icon="warning"
        title={t(
          python.kind === "incompatible"
            ? "pythonIncompatible"
            : "pythonUnavailable",
        )}
        description={
          python.kind === "incompatible"
            ? t("versionMismatch", {
                found: python.version,
                expected: `API ${expectedPythonApiVersion}`,
              })
            : t("pythonUnavailableHint")
        }
        action={
          <Button variant="primary" icon="refresh" onClick={() => void probe()}>
            {t("retry")}
          </Button>
        }
      />
    </main>
  );
};
