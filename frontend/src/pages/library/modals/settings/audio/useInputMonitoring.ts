import { store } from '../../../../../providers/store';
import { tr, useLocale } from '@neo-ui-kit/react';
import { monitoringErrorText } from '../../../../../shared/errors';
import { useEffect, useRef, useState } from 'react';
import { observable, runInAction } from 'mobx';
import { useNotify } from '../../../../../providers/notifications';
import { applyVoiceChain } from '../../../../../features/karaoke/console/voiceChain';
import { audioClient as audio } from '../../../../../services/audioClient';
import { audioSessionFor } from './audioSession';

const meterIntervalMs = 100;

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
  const [inputLevel] = useState(() => observable.box(0));
  const [testingInput, setTestingInputState] = useState(false);

  useEffect(() => {
    if (!testingInput) return;
    let stopped = false;
    let ownsAudio = false;
    let stopSamples: (() => void) | undefined;
    const reportError = (error: unknown) => {
      const { notify } = latest.current;
      notify(
        `${tr('inputTestFailed')}: ${monitoringErrorText(error)}`,
        'error',
      );
    };
    const sample = () => {
      stopSamples = audio.observeSnapshots(snapshot => {
        if (stopped) return;
        runInAction(() => inputLevel.set(snapshot.inputLevel));
        if (snapshot.monitoringSafetyTripped) {
          const { notify } = latest.current;
          notify(tr('monitoringSafetyStopped'), 'error');
          setTestingInputState(false);
        }
      }, error => {
        if (stopped) return;
        reportError(error);
        setTestingInputState(false);
      }, meterIntervalMs);
      void session.refresh();
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
      stopSamples?.();
      runInAction(() => inputLevel.set(0));
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
  }, [audio, session, testingInput, inputLevel]);

  return {
    inputLevel,
    testingInput,
    canToggle: testingInput || canStart,
    setTestingInput: (enabled: boolean) => {
      if (!enabled || canStart) setTestingInputState(enabled);
    },
  };
};
