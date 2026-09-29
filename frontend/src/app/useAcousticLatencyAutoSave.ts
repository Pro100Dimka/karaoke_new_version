import { useEffect, useRef } from "react";
import { audioClient } from "../services/audioClient";
import { acousticLatencyKey } from "../shared/preferences/preferences";
import { useApp } from "./AppContext";

// AudioService re-checks the hidden delay about once per second of song; saving every few seconds
// keeps up with it without extra work.
const checkMilliseconds = 5_000;
// AudioService accepts an estimate only when successive ones agree within a millisecond, so a
// smaller difference from the stored value is not a new measurement.
const changeMilliseconds = 1;

/**
 * Keeps the hidden speaker-to-microphone delay of the current device setup up to date without a
 * test signal: what AudioService found from the song the microphone hears is saved (and so applied)
 * exactly like a chirp measurement.
 */
export const useAcousticLatencyAutoSave = (): void => {
  const app = useApp();
  const latest = useRef(app);
  latest.current = app;
  useEffect(() => {
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const found = await audioClient.passiveAcousticLatency();
        const { preferences, updatePreferences } = latest.current;
        // An estimate from a mode other than the chosen one describes another device path.
        if (!found || found.backend !== preferences.audio.backend) return;
        const key = acousticLatencyKey(preferences.audio);
        const milliseconds = Math.round(found.milliseconds * 10) / 10;
        const stored = preferences.acousticLatencyMs[key];
        if (stored !== undefined && Math.abs(stored - milliseconds) < changeMilliseconds) return;
        updatePreferences({ acousticLatencyMs: { ...preferences.acousticLatencyMs, [key]: milliseconds } });
      } catch {
        // AudioService is unavailable for now; the next check tries again.
      } finally {
        checking = false;
      }
    };
    const timer = window.setInterval(() => void check(), checkMilliseconds);
    return () => window.clearInterval(timer);
  }, []);
};
