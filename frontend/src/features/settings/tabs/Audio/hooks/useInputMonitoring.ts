import { useEffect, useRef, useState } from "react";
import { useApp } from "../../../../../app/AppContext";
import { useNotify } from "../../../../../app/NotificationsProvider";
import { monitoringErrorText, useText } from "../../../../../i18n/useText";
import { applyVoiceChain } from "../../../../karaoke/console/voiceChain";
import { useSettingsAudio } from "../../../../../app/SettingsProvider";
import { audioSessionFor } from "../model/audioSession";

const meterIntervalMs = 100;
const safetyCheckEvery = 5;

/** The input test owns monitoring only between its explicit start and cleanup. */
export const useInputMonitoring = (canStart: boolean) => {
  const audio = useSettingsAudio();
  const session = audioSessionFor(audio);
  const t = useText();
  const notify = useNotify();
  const { preferences } = useApp("preferences");
  const latest = useRef({ preferences, notify, t });
  useEffect(() => {
    latest.current = { preferences, notify, t };
  }, [preferences, notify, t]);
  const [inputLevel, setInputLevel] = useState(0);
  const [testingInput, setTestingInputState] = useState(false);

  useEffect(() => {
    if (!testingInput) return;
    let stopped = false;
    let ownsAudio = false;
    let samples = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reportError = (error: unknown) => {
      const { notify, t } = latest.current;
      notify(
        `${t("inputTestFailed")}: ${monitoringErrorText(error, t)}`,
        "error",
      );
    };
    const sample = async () => {
      try {
        const level = await audio.testInputLevel();
        if (stopped) return;
        setInputLevel(level);
        if (samples % safetyCheckEvery === 0) {
          const snapshot = await audio.snapshot();
          if (stopped) return;
          if (snapshot.monitoringSafetyTripped) {
            const { notify, t } = latest.current;
            notify(t("monitoringSafetyStopped"), "error");
            setTestingInputState(false);
            return;
          }
        }
        if (samples++ === 0) void session.refresh();
        timer = setTimeout(() => void sample(), meterIntervalMs);
      } catch (error) {
        if (stopped) return;
        reportError(error);
        setTestingInputState(false);
      }
    };
    void session
      .enqueue(async () => {
        if (stopped) return false;
        ownsAudio = true;
        await audio.setDspEnabled(false);
        if (stopped) return false;
        await audio.setMonitoring(true);
        return !stopped;
      })
      .then((started) => {
        if (started && !stopped) void sample();
      })
      .catch((error: unknown) => {
        if (stopped) return;
        reportError(error);
        setTestingInputState(false);
      });

    return () => {
      stopped = true;
      clearTimeout(timer);
      setInputLevel(0);
      // Finish the old start/stop before a rapid re-enable or a reopened tab.
      // An old request can therefore never switch off the next input test.
      void session
        .enqueue(async () => {
          if (!ownsAudio) return;
          try {
            await audio.setMonitoring(false);
          } finally {
            await applyVoiceChain(latest.current.preferences, audio);
          }
        })
        .catch(reportError);
    };
  }, [audio, session, testingInput]);

  return {
    inputLevel,
    testingInput,
    canToggle: testingInput || canStart,
    setTestingInput: (enabled: boolean) => {
      if (!enabled || canStart) setTestingInputState(enabled);
    },
  };
};
