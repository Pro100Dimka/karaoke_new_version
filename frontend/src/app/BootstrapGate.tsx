import { observer } from "mobx-react-lite";
import { store } from "../providers/store";
import { useEffect, useState, type ReactNode } from "react";
import { ru } from "../i18n/messages.ru";
import { audioClient } from "../services/audioClient";
import { safeAudioConfiguration } from "../shared/preferences/preferences";
import { desktopClient } from "../services/desktopClient";
import { Button, EmptyState, tr, useLocale } from "@neo-ui-kit/react";
import { expectedPythonApiVersion } from "./serviceStatus";

import { useVoiceChain } from "../features/karaoke/console/voiceChain";
import { useAcousticLatencyAutoSave } from "./useAcousticLatencyAutoSave";
import { useLowLatencyMicrophoneNotice } from "./useLowLatencyMicrophoneNotice";

/**
 * Holds the interface until the backend status is known so no control is usable before its service is.
 * AudioService trouble never blocks the offline Library; it only disables live-audio features later.
 */
export const BootstrapGate = observer(({ children }: { children: ReactNode }) => {
  const { python, probe } = store.application.services;
  const { preferences, updatePreferences } = store;
  useLocale();
  const [admitted, setAdmitted] = useState(false);

  useEffect(() => {
    let active = true;
    audioClient.setPreferredConfiguration(preferences.audio);
    if (preferences.audio.backend === "ASIO") {
      void audioClient
        .listDevices()
        .then((devices) => {
          if (!active) return;
          const safe = safeAudioConfiguration(preferences.audio, devices);
          if (safe === preferences.audio) return;
          audioClient.setPreferredConfiguration(safe);
          updatePreferences({ audio: safe });
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [preferences.audio, updatePreferences]);

  useAcousticLatencyAutoSave();
  useLowLatencyMicrophoneNotice();
  useVoiceChain();

  useEffect(() => {
    if (python.kind === "ready") setAdmitted(true);
  }, [python.kind]);

  // The window stays hidden until the app (or its error screen) has painted two frames behind the splash.
  useEffect(() => {
    const waiting = python.kind === "starting" || (python.kind === "ready" && !admitted);
    let paintedFrames = 0;
    let frame = 0;
    const paint = () => {
      if (!waiting) paintedFrames += 1;
      if (paintedFrames === 2) void desktopClient.appReady();
      else frame = window.requestAnimationFrame(paint);
    };
    // Keep scheduling frames while hidden so the first ready frame does not wait for an idle renderer.
    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [python.kind, admitted]);

  if (admitted) return <>{children}</>;

  if (python.kind === "starting") {
    return null;
  }

  return (
    <main className="bootstrapState" role="alert">
      <EmptyState
        icon="warning"
        title={tr(
          ru[python.kind === "incompatible"
            ? "pythonIncompatible"
            : "pythonUnavailable"],
        )}
        description={
          python.kind === "incompatible"
            ? tr(ru.versionMismatch, {
                found: python.version,
                expected: `API ${expectedPythonApiVersion}`,
              })
            : tr(ru.pythonUnavailableHint)
        }
        action={
          <Button variant="primary" icon="refresh" onClick={() => void probe()}>
            {tr(ru.retry)}
          </Button>
        }
      />
    </main>
  );
});
