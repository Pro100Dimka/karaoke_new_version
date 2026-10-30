import { Form, Button, Dialog, Grid, MessageBar, tr } from '@neo-ui-kit/react';
import { desktopClient } from '../../../../../services/desktopClient';
import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { store } from '../../../../../providers/store';
import { parsePreferences } from '../../../../../shared/preferences/preferences';
import { useAudioSettings } from './useAudioSettings';
import { useInputMonitoring } from './useInputMonitoring';
import useSettingsForm from '../form';
import { AsioSetupCard } from './AsioSetupCard';
import { ru } from '../../../../../i18n/messages.ru';
import FormCards from '../form-cards';
import AudioDiagnostics from './diagnostics';
import { blocks } from './rows';

const AudioPanel = observer(() => {
  const audio = useAudioSettings(true);
  const monitoring = useInputMonitoring(audio.audio.audioAvailable && audio.audio.capabilities.microphone === "ready");
  const form = useSettingsForm({
    audio: { ...store.audio, configuration: { ...audio.audio.values, bufferFrames: audio.audio.values.backend === "WASAPI Shared"
      ? audio.audio.values.periodFrames : audio.audio.values.bufferFrames },
      voice: { ...store.audio.voice, monitoring: monitoring.testingInput } },
    audioStatus: { ...audio.audio, inputLevel: monitoring.inputLevel, canToggle: monitoring.canToggle, ready: audio.ready },
  }, (path, value) => {
    const backend = (["ASIO", "WASAPI Shared", "WASAPI Exclusive"] as const).find(item => item === value);
    if (path === "audio.voice.monitoring" && typeof value === "boolean") {
      monitoring.setTestingInput(value);
    } else if (path === "audio.configuration.backend" && backend) {
      audio.audio.onAudioCommit("backend", backend);
    } else if (path === "audio.configuration.lowLatencyInput" && typeof value === "boolean") {
      audio.audio.onAudioCommit("lowLatencyInput", value);
    } else if (path === "audio.releaseAsioInBackground" && typeof value === "boolean") {
      audio.audio.onReleaseAsioInBackgroundChange(value);
    } else if (path === "audio.voice.gain" && typeof value === "number") {
      const parsed = parsePreferences({ ...store.preferences, voiceGain: value });
      store.updatePreferences({ voiceGain: parsed.voiceGain });
    } else if (path === "audio.voice.effects.noiseSuppression" && typeof value === "number") {
      const parsed = parsePreferences({ ...store.preferences, noiseSuppression: value });
      store.updatePreferences({ noiseSuppression: parsed.noiseSuppression });
    } else {
      const numberKey = (["sampleRate", "bufferFrames", "periodFrames", "inputPeriodFrames"] as const)
        .find((key) => path === `audio.configuration.${key}`);
      const deviceKey = (["inputDeviceId", "outputDeviceId"] as const)
        .find((key) => path === `audio.configuration.${key}`);
      if (numberKey && typeof value === "number") audio.audio.onAudioCommit(numberKey === "bufferFrames" && audio.audio.values.backend === "WASAPI Shared"
        ? "periodFrames" : numberKey, value);
      else if (deviceKey && typeof value === "string") audio.audio.onAudioCommit(deviceKey, value);
    }
  });
  const [diagnostics, setDiagnostics] = useState(false);
  const status = form.values.audioStatus;
  const drivers = status.devices.filter((device) => device.backend === 'ASIO');
  const selected = drivers.find((device) => device.id === status.values.outputDeviceId)
    ?? drivers.find((device) => device.id === status.values.inputDeviceId) ?? drivers[0];
  const asio4all = /asio4all/i.test(selected?.name ?? '');
  const microphone = status.capabilities.microphone;
  const microphoneMessages = {
    ready: ru.microphoneReady, 'permission-denied': ru.microphonePermissionDenied,
    'privacy-disabled': ru.microphonePrivacyDisabled, missing: ru.microphoneMissing, busy: ru.microphoneBusy,
  };
  return (<Form form={form}>
    <FormCards blocks={blocks(form.values, () => setDiagnostics(true))} level={4}>
      {status.ready && !status.audioAvailable && <Grid span="full"><MessageBar tone="error">{tr(ru.audioServiceUnavailable)}</MessageBar></Grid>}
      {status.asioUnavailable && drivers.length > 0 && <Grid span="full"><MessageBar tone="error">{tr(ru.asioDriverOpenFailed)}</MessageBar></Grid>}
      {status.audioAvailable && microphone !== 'ready' && <Grid span="full"><MessageBar tone="warning"
        action={['permission-denied', 'privacy-disabled'].includes(microphone) &&
          <Button size="sm" label={tr(ru.openMicrophonePrivacy)} onClick={() => void desktopClient.openMicrophonePrivacy()} />}>
        {tr(microphoneMessages[microphone])}
      </MessageBar></Grid>}
      {status.values.backend === 'ASIO' && (!drivers.length || asio4all || status.asioReadyToRestart) && (
        <Grid span="full"><AsioSetupCard hasAsio4All={drivers.some((device) => /asio4all/i.test(device.name))}
          readyToRestart={status.asioReadyToRestart} onAsioDriverDetected={status.onAsioDriverDetected}
          onOpenAsioControlPanel={status.onOpenAsioControlPanel} /></Grid>
      )}
    </FormCards>
    <Dialog open={diagnostics} onOpenChange={setDiagnostics} title={tr(ru.latencyTechnicalDetails)}
      cancelLabel={false} confirmLabel={false}>
      {diagnostics && <AudioDiagnostics />}
    </Dialog>
  </Form>);
});
export default AudioPanel;
