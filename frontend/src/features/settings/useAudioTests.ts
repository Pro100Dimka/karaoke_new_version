import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeAudioConfiguration } from "../../contracts/models";
import { useNotify } from "../../app/NotificationsProvider";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";

const meterIntervalMilliseconds = 100;
const wait = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds));
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Input test as a switch: while it is on the microphone is monitored and its level is polled. It ends when the user
 * turns it off or leaves the settings, and monitoring is always switched off with it.
 */
export const useAudioTests = (settingsOpen: boolean, onRuntimeChange: (runtime: RuntimeAudioConfiguration) => void) => {
  const t = useText();
  const notify = useNotify();
  const [inputLevel, setInputLevel] = useState(0);
  const [testingInput, setTestingInput] = useState(false);
  // The running test must not restart when a callback identity changes, so the loop reads the latest ones from a ref.
  const latest = useRef({ notify, t, onRuntimeChange });
  latest.current = { notify, t, onRuntimeChange };

  useEffect(() => {
    if (!settingsOpen) setTestingInput(false);
  }, [settingsOpen]);

  useEffect(() => {
    if (!testingInput) return undefined;
    let stopped = false;
    void (async () => {
      try {
        // The test always plays the clean voice; karaoke effects and noise suppression are not part of it.
        await audioClient.setDspEnabled(false);
        await audioClient.setMonitoring(true);
        let reportedRuntime = false;
        while (!stopped) {
          setInputLevel(await audioClient.testInputLevel());
          if (!reportedRuntime) {
            reportedRuntime = true;
            latest.current.onRuntimeChange(await audioClient.runtimeConfiguration());
          }
          await wait(meterIntervalMilliseconds);
        }
      } catch (error) {
        if (stopped) return;
        latest.current.notify(`${latest.current.t("inputTestFailed")}: ${reasonOf(error)}`, "error");
        setTestingInput(false);
      }
    })();
    return () => {
      stopped = true;
      setInputLevel(0);
      void audioClient.setMonitoring(false).catch(() => undefined);
    };
  }, [testingInput]);

  const playTestSound = useCallback(async () => {
    try {
      await audioClient.playTestSound();
    } catch (error) {
      notify(`${t("outputTestFailed")}: ${reasonOf(error)}`, "error");
    }
  }, [notify, t]);

  return { inputLevel, testingInput, setTestingInput, playTestSound };
};
