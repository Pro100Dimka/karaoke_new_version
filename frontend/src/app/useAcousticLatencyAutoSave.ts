import { useEffect, useRef } from "react";
import { audioClient } from "../services/audioClient";
import { useApp } from "./AppContext";

// AudioService re-checks the hidden delay about once per second of song; saving every few seconds
// keeps up with it without extra work. The same check notices a newly opened device path.
const checkMilliseconds = 5_000;
// AudioService accepts an estimate only when successive ones agree within a millisecond, so a
// smaller difference from the stored value is not a new measurement.
const changeMilliseconds = 1;

/**
 * Hands AudioService the delays measured per device path (it applies the matching one whenever a
 * path opens, before audio starts), then refines a verified calibration while AudioService still
 * accepts its context.
 */
export const useAcousticLatencyAutoSave = (): void => {
  const app = useApp("preferences");
  const latest = useRef(app);
  latest.current = app;
  useEffect(() => {
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        await audioClient.rememberAcousticLatencies(latest.current.preferences.acousticLatencyMs);
        const found = await audioClient.passiveAcousticLatency();
        if (!found?.fingerprint) return;
        const { preferences } = latest.current;
        const milliseconds = Math.round(found.milliseconds * 10) / 10;
        const stored = preferences.acousticLatencyMs[found.fingerprint];
        if (
          stored !== undefined &&
          Math.abs(stored - milliseconds) < changeMilliseconds
        )
          return;
        await audioClient.setAcousticLatency(milliseconds, found.context);
        const current = latest.current;
        current.updatePreferences({
          acousticLatencyMs: {
            ...current.preferences.acousticLatencyMs,
            [found.fingerprint]: milliseconds,
          },
        });
      } catch {
        // AudioService is unavailable for now; the next check tries again.
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), checkMilliseconds);
    return () => window.clearInterval(timer);
  }, []);
};
