import { store } from "../../../../../providers/store";
import { tr, useLocale } from "@neo-ui-kit/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNotify } from "../../../../../providers/notifications";
import type { RuntimeAudioConfiguration } from "../../../../../contracts/models";
import { ru } from "../../../../../i18n/messages.ru";
import { audioClient as audio } from "../../../../../services/audioClient";

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Owns a measurement only while its mounted audio context remains current. */
export const useAcousticCalibration = (
  audioAvailable: boolean,
  runtime: RuntimeAudioConfiguration,
) => {
  useLocale();
  const notify = useNotify();
  const { preferences, updatePreferences } = store;
  const [measuring, setMeasuring] = useState(false);
  const activeContext = runtime.calibrationContext ?? "";
  const mounted = useRef(false);
  const pending = useRef(false);
  const current = useRef({ preferences, activeContext });
  useLayoutEffect(() => {
    current.current = { preferences, activeContext };
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [latest, setLatest] = useState<{
    context: string;
    milliseconds: number;
  }>();
  // Persisted history never proves that the currently opened default device has been calibrated.
  const measured = audioAvailable
    ? (runtime.calibratedLatencyMs ??
      (latest?.context === activeContext ? latest.milliseconds : undefined))
    : undefined;

  const measure = async () => {
    if (pending.current) return;
    pending.current = true;
    setMeasuring(true);
    try {
      const measured = await audio.measureAcousticLatency();
      if (!mounted.current || current.current.activeContext !== activeContext)
        return;
      const milliseconds = Math.round(measured.milliseconds);
      setLatest({ context: activeContext, milliseconds });
      // Saved for exactly the device path it was measured on, and restored on it after a restart.
      if (measured.fingerprint)
        updatePreferences({
          acousticLatencyMs: {
            ...current.current.preferences.acousticLatencyMs,
            [measured.fingerprint]: measured.milliseconds,
          },
        });
      notify(tr(ru.acousticLatencyMeasured, { value: milliseconds }), "success");
    } catch (error) {
      if (!mounted.current || current.current.activeContext !== activeContext)
        return;
      // Playing a song ends the optional measurement on purpose; that is not a failure.
      if (
        error instanceof Error &&
        error.name === "AcousticMeasurementCancelled"
      )
        notify(tr(ru.acousticLatencyCancelled), "info");
      else notify(`${tr(ru.acousticLatencyFailed)}: ${reasonOf(error)}`, "error");
    } finally {
      pending.current = false;
      if (mounted.current) setMeasuring(false);
    }
  };

  return {
    measuring,
    measured,
    measuredHere: latest?.context === activeContext,
    measure,
  };
};
