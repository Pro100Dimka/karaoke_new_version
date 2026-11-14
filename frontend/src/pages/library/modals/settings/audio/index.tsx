import { Button, Dialog, Grid, MessageBar, tr } from '@neo-ui-kit/react';
import { desktopClient } from '../../../../../services/desktopClient';
import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useAudioSettings } from './useAudioSettings';
import { useInputMonitoring } from './useInputMonitoring';
import { AsioSetupCard } from './AsioSetupCard';
import AudioDiagnostics from './diagnostics';
import { AudioFields } from './rows';

const AudioPanel = observer(() => {
  const audio = useAudioSettings(true);
  const monitoring = useInputMonitoring(
    audio.audio.audioAvailable &&
      audio.audio.capabilities.microphone === 'ready',
  );
  const [diagnostics, setDiagnostics] = useState(false);
  const status = { ...audio.audio, ready: audio.ready };
  const drivers = status.devices.filter((device) => device.backend === 'ASIO');
  const selected =
    drivers.find((device) => device.id === status.values.outputDeviceId) ??
    drivers.find((device) => device.id === status.values.inputDeviceId) ??
    drivers[0];
  const asio4all = /asio4all/i.test(selected?.name ?? '');
  const microphone = status.capabilities.microphone;
  const microphoneMessages = {
    ready: 'microphoneReady',
    'permission-denied': 'microphonePermissionDenied',
    'privacy-disabled': 'microphonePrivacyDisabled',
    missing: 'microphoneMissing',
    busy: 'microphoneBusy',
  };
  return (
    <>
      <Grid columns={12} gap={3} style={{ height: '100%' }}>
        <AudioFields
          status={status}
          monitoring={monitoring}
          showDiagnostics={() => setDiagnostics(true)}
        />
        {status.ready && !status.audioAvailable && (
          <Grid span="full">
            <MessageBar tone="error">
              {tr('audioServiceUnavailable')}
            </MessageBar>
          </Grid>
        )}
        {status.asioUnavailable && drivers.length > 0 && (
          <Grid span="full">
            <MessageBar tone="error">{tr('asioDriverOpenFailed')}</MessageBar>
          </Grid>
        )}
        {status.audioAvailable && microphone !== 'ready' && (
          <Grid span="full">
            <MessageBar
              tone="warning"
              action={
                ['permission-denied', 'privacy-disabled'].includes(
                  microphone,
                ) && (
                  <Button
                    size="sm"
                    label={tr('openMicrophonePrivacy')}
                    onClick={() => void desktopClient.openMicrophonePrivacy()}
                  />
                )
              }
            >
              {tr(microphoneMessages[microphone])}
            </MessageBar>
          </Grid>
        )}
        {status.values.backend === 'ASIO' &&
          (!drivers.length || asio4all || status.asioReadyToRestart) && (
            <Grid span="full">
              <AsioSetupCard
                hasAsio4All={drivers.some((device) =>
                  /asio4all/i.test(device.name),
                )}
                readyToRestart={status.asioReadyToRestart}
                onAsioDriverDetected={status.onAsioDriverDetected}
                onOpenAsioControlPanel={status.onOpenAsioControlPanel}
              />
            </Grid>
          )}
      </Grid>
      <Dialog
        open={diagnostics}
        onOpenChange={setDiagnostics}
        title={tr('latencyTechnicalDetails')}
        cancelLabel={false}
        confirmLabel={false}
      >
        {diagnostics && <AudioDiagnostics status={status} />}
      </Dialog>
    </>
  );
});
export default AudioPanel;
