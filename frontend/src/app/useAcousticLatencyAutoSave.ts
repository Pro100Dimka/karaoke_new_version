import { store } from "../providers/store";
import { useEffect } from "react";
import { audioClient } from "../services/audioClient";

// Persist optional measurements and restore existing profiles. Ordinary playback never waits for
// a measurement, music/microphone correlation, a dialog, or a sound emitted for calibration.
const checkMilliseconds = 5_000;
const changeMilliseconds = 1;

export const useAcousticLatencyAutoSave = (): void => {
  useEffect(() => {
    let checking = false;
    let disposed = false;
    const save = (fingerprint: string, milliseconds: number) => {
      if (disposed || !Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 500) return;
      const current = store;
      const stored = current.preferences.acousticLatencyMs[fingerprint];
      if (stored !== undefined && Math.abs(stored - milliseconds) < changeMilliseconds) return;
      current.updatePreferences({
        acousticLatencyMs: { ...current.preferences.acousticLatencyMs, [fingerprint]: milliseconds },
      });
    };
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        await audioClient.rememberAcousticLatencies(store.preferences.acousticLatencyMs);
        const state = await audioClient.acousticCalibrationState();
        if (disposed || !state.fingerprint) return;
        if (state.milliseconds !== null && (state.origin === "SONG" || state.origin === "TEST_SIGNAL"))
          save(state.fingerprint, Math.round(state.milliseconds * 10) / 10);
      } catch {
        // AudioService is unavailable for now; the next check tries again.
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), checkMilliseconds);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);
};
