import { Button, Dialog, Grid, MessageBar, tr } from '@neo-ui-kit/react';
import { desktopClient } from '../../../../../services/desktopClient';
import { useState } from 'react';
import type { SettingsPanelProps } from '../../../../../utils/contracts';
import { AsioSetupCard } from './AsioSetupCard';
import { ru } from '../../../../../i18n/messages.ru';
import FormCards from '../form-cards';
import AudioDiagnostics from './diagnostics';
import { blocks } from './rows';

const AudioPanel = ({ form }: SettingsPanelProps) => {
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
  return (<>
    <FormCards blocks={blocks(form, () => setDiagnostics(true))} level={4}>
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
      {diagnostics && <AudioDiagnostics form={form} />}
    </Dialog>
  </>);
};
export default AudioPanel;
