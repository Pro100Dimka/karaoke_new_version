import { useEffect, useRef } from "react";
import { audioClient } from "../services/audioClient";
import { useText } from "../i18n/useText";
import { useApp } from "./AppContext";
import { useAsk } from "./DialogProvider";
import { useNotify } from "./NotificationsProvider";

// AudioService adopts what the song shows between songs; a check every few seconds saves it soon
// after and notices a newly opened device path.
const checkMilliseconds = 5_000;
// The estimate repeats within a millisecond; a smaller difference from the saved value is not new.
const changeMilliseconds = 1;

/**
 * Keeps the acoustic part of each device path known without a manual measurement: hands AudioService
 * the saved calibrations (applied as a path opens), saves what AudioService determined itself from
 * the song the microphone hears, and, when a whole song gave no estimate (headphones, a muted
 * microphone), asks once whether to determine it with three quiet test signals.
 */
export const useAcousticLatencyAutoSave = (): void => {
  const app = useApp("preferences");
  const latest = useRef(app);
  latest.current = app;
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();
  const tools = useRef({ ask, notify, t });
  tools.current = { ask, notify, t };
  useEffect(() => {
    let checking = false;
    // Device paths a song was heard on in this run, and paths already asked about.
    const songHeard = new Set<string>();
    const asked = new Set<string>();
    const save = (fingerprint: string, milliseconds: number) => {
      const current = latest.current;
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
        await audioClient.rememberAcousticLatencies(latest.current.preferences.acousticLatencyMs);
        const state = await audioClient.acousticCalibrationState();
        if (!state.fingerprint) return;
        if (state.milliseconds !== null && (state.origin === "SONG" || state.origin === "TEST_SIGNAL"))
          save(state.fingerprint, Math.round(state.milliseconds * 10) / 10);
        if (state.songPlaying) songHeard.add(state.fingerprint);
        const unresolved =
          state.origin === "NONE" &&
          !state.songPlaying &&
          state.songEstimates === 0 &&
          songHeard.has(state.fingerprint) &&
          !asked.has(state.fingerprint);
        if (!unresolved) return;
        asked.add(state.fingerprint);
        const { ask: askUser, notify: tell, t: text } = tools.current;
        const answer = await askUser({
          title: text("acousticSetupTitle"),
          body: text("acousticSetupBody"),
          tone: "info",
          actions: [
            { id: "later", label: text("acousticSetupLater") },
            { id: "measure", label: text("acousticSetupMeasure"), appearance: "primary" },
          ],
        });
        if (answer !== "measure") return;
        try {
          const measured = await audioClient.measureAcousticLatency();
          if (measured.fingerprint) save(measured.fingerprint, measured.milliseconds);
          tell(text("acousticLatencyMeasured", { value: Math.round(measured.milliseconds) }), "success");
        } catch (error) {
          tell(`${text("acousticLatencyFailed")}: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
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
