import { store } from "../../../../../providers/store";
import { tr, useLocale } from "@neo-ui-kit/react";
import { ru } from "../../../../../i18n/messages.ru";
import { monitoringErrorText } from "../../../../../shared/errors";
import { useEffect, useRef, useState } from "react";
import { useNotify } from "../../../../../providers/notifications";
import { applyVoiceChain } from "../../../../../features/karaoke/console/voiceChain";
import { audioClient as audio } from "../../../../../services/audioClient";
import { audioSessionFor } from "./audioSession";

const meterIntervalMs = 100;
const safetyCheckEvery = 5;

/** The input test owns monitoring only between its explicit start and cleanup. */
export const useInputMonitoring = (canStart: boolean) => {
  const session = audioSessionFor(audio);
  const locale = useLocale();
  const notify = useNotify();
  const { preferences } = store;
  const latest = useRef({ preferences, notify });
  useEffect(() => {
    latest.current = { preferences, notify };
  }, [preferences, notify, locale]);
  const [inputLevel, setInputLevel] = useState(0);
  const [testingInput, setTestingInputState] = useState(false);

  useEffect(() => {
    if (!testingInput) return;
    let stopped = false;
    let ownsAudio = false;
    let samples = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reportError = (error: unknown) => {
      const { notify } = latest.current;
      notify(
        `${tr(ru.inputTestFailed)}: ${monitoringErrorText(error)}`,
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
            const { notify } = latest.current;
            notify(tr(ru.monitoringSafetyStopped), "error");
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
        await applyVoiceChain(latest.current.preferences, audio);
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
