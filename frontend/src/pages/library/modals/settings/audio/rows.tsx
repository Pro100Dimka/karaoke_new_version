import {
  Button,
  Card,
  Grid,
  IconButton,
  LevelMeter,
  RotaryKnob,
  Select,
  Stack,
  StatusIndicator,
  Switch,
  Tooltip,
  tr,
  Typography,
} from '@neo-ui-kit/react';
import type { AudioBackendName } from '../../../../../contracts/models';
import type { IObservableValue } from 'mobx';
import { observer } from 'mobx-react-lite';
import { store } from '../../../../../providers/store';
import { parsePreferences } from '../../../../../shared/preferences/preferences';
import type { useAudioSettings } from './useAudioSettings';
import type { useInputMonitoring } from './useInputMonitoring';
import FormButton from '../form-button';

const InputLevelMeter = observer(
  ({ level, active }: { level: IObservableValue<number>; active: boolean }) => (
    <LevelMeter
      value={Math.min(1, level.get() * 4) * 100}
      active={active}
      label={tr('liveInputLevel')}
    />
  ),
);
const rotaryProps = {
  size: 'sm',
  showLabel: true,
  min: 0,
  step: 0.01,
  displayScale: 100,
} as const;
export const AudioFields = observer(
  ({
    status,
    monitoring,
    showDiagnostics,
  }: {
    status: ReturnType<typeof useAudioSettings>['audio'] & { ready: boolean };
    monitoring: ReturnType<typeof useInputMonitoring>;
    showDiagnostics(): void;
  }) => {
    const { runtime, values, onAudioCommit } = status;
    const usb =
      runtime.latencyEstimateSource === 'device-timeline'
        ? (runtime.usbLatency?.inputMs ?? 0) +
          (runtime.usbLatency?.outputMs ?? 0)
        : 0;
    const latency =
      status.audioAvailable && runtime.estimatedLatencyMs !== null
        ? runtime.estimatedLatencyMs + usb
        : null;
    return (
      <>
        <Grid span={{ base: 'full', md: 6, lg: 5 }}>
          <Card
            border
            level={4}
            title={tr('estimatedLatencyTitle')}
            icon="timer"
            style={{ height: '100%', background: 'transparent' }}
            actions={
              <Tooltip content={tr('audioLatencyHint')}>
                <IconButton
                  icon="info"
                  size="sm"
                  variant="ghost"
                  label={tr('audioLatencyHint')}
                  onClick={showDiagnostics}
                />
              </Tooltip>
            }
          >
            <Grid
              columns={12}
              gap={3}
              align="center"
              className="ad-form-fields"
            >
              <Grid span="full" className="ad-form-field" data-custom="">
                <Stack gap={3}>
                  <InputLevelMeter
                    level={monitoring.inputLevel}
                    active={monitoring.testingInput}
                  />
                  <Stack direction="row" gap={3} align="center" wrap>
                    <Typography
                      variant="h3"
                      as="strong"
                      text={
                        latency === null
                          ? '-'
                          : tr('approximateMillisecondsValue', {
                              value: Math.round(latency),
                            })
                      }
                    />
                    <StatusIndicator
                      status={status.audioAvailable ? 'warning' : 'offline'}
                      label={tr(
                        status.audioAvailable
                          ? 'latencyIncomplete'
                          : 'audioNoData',
                      )}
                    />
                  </Stack>
                </Stack>
              </Grid>
              <Grid span={{ base: 'full', sm: 4 }} className="ad-form-field">
                <Select<AudioBackendName>
                  label={tr('audioBackend')}
                  value={values.backend}
                  disabled={!status.ready}
                  options={[
                    { value: 'ASIO', label: 'ASIO' },
                    {
                      value:
                        values.backend === 'ASIO'
                          ? 'WASAPI Shared'
                          : values.backend,
                      label: 'Windows',
                    },
                  ]}
                  onValueChange={(value) => onAudioCommit('backend', value)}
                />
              </Grid>
              {(
                [
                  {
                    key: 'sampleRate',
                    label: 'sampleRate',
                    options: status.options.sampleRates,
                  },
                  {
                    key: 'bufferFrames',
                    label: 'audioBuffer',
                    options: status.options.periods,
                  },
                ] as const
              ).map(({ key, label, options }) => (
                <Grid
                  key={key}
                  span={{ base: 'full', sm: 4 }}
                  className="ad-form-field"
                >
                  <Select
                    label={tr(label)}
                    value={
                      key === 'bufferFrames' &&
                      values.backend === 'WASAPI Shared'
                        ? values.periodFrames
                        : values[key]
                    }
                    disabled={
                      key === 'bufferFrames' &&
                      values.backend === 'WASAPI Exclusive'
                    }
                    options={options}
                    onValueChange={(value) =>
                      onAudioCommit(
                        key === 'bufferFrames' &&
                          values.backend === 'WASAPI Shared'
                          ? 'periodFrames'
                          : key,
                        value,
                      )
                    }
                  />
                </Grid>
              ))}
              <Grid span="full" className="ad-form-field" data-custom="">
                <Button
                  size="sm"
                  icon="sliders"
                  disabled={!status.audioAvailable || values.backend !== 'ASIO'}
                  label={tr('audioConfigureDevices')}
                  onClick={status.onOpenAsioControlPanel}
                />
              </Grid>
            </Grid>
          </Card>
        </Grid>
        <Grid span={{ base: 'full', md: 6, lg: 4 }}>
          <Card
            border
            level={4}
            title={tr('audioLevels')}
            icon="levels"
            style={{ height: '100%', background: 'transparent' }}
          >
            <Grid
              columns={12}
              gap={3}
              align="center"
              className="ad-form-fields"
            >
              <Grid span={5} className="ad-form-field">
                <RotaryKnob
                  {...rotaryProps}
                  max={4}
                  resetValue={1}
                  label={tr('microphoneKnob')}
                  value={store.preferences.voiceGain}
                  onValueChange={(voiceGain) =>
                    store.updatePreferences({
                      voiceGain: parsePreferences({
                        ...store.preferences,
                        voiceGain,
                      }).voiceGain,
                    })
                  }
                />
              </Grid>
              <Grid span={2} className="ad-form-field" data-custom="">
                <FormButton
                  icon="mic"
                  label={tr('inputMonitoring')}
                  caption={tr('monitoring')}
                  disabled={!monitoring.canToggle}
                  aria-pressed={monitoring.testingInput}
                  variant={monitoring.testingInput ? 'primary' : 'secondary'}
                  onClick={() =>
                    monitoring.setTestingInput(!monitoring.testingInput)
                  }
                />
              </Grid>
              <Grid span={5} className="ad-form-field">
                <RotaryKnob
                  {...rotaryProps}
                  max={1}
                  resetValue={0}
                  label={tr('noiseKnob')}
                  value={store.preferences.noiseSuppression}
                  onValueChange={(noiseSuppression) =>
                    store.updatePreferences({
                      noiseSuppression: parsePreferences({
                        ...store.preferences,
                        noiseSuppression,
                      }).noiseSuppression,
                    })
                  }
                />
              </Grid>
            </Grid>
          </Card>
        </Grid>
        <Grid span={{ base: 'full', lg: 3 }}>
          <Card
            border
            level={4}
            title={tr('audioDevicesAndMonitoring')}
            icon="headphones"
            style={{ height: '100%', background: 'transparent' }}
          >
            <Grid
              columns={12}
              gap={3}
              align="center"
              className="ad-form-fields"
            >
              {(
                [
                  {
                    key: 'inputDeviceId',
                    label: 'audioInputDevice',
                    direction: 'input',
                    span: 'full',
                  },
                  {
                    key: 'outputDeviceId',
                    label: 'audioOutputDevice',
                    direction: 'output',
                    span: { base: 'full', sm: 10 },
                  },
                ] as const
              ).map(({ key, label, direction, span }) => (
                <Grid key={key} span={span} className="ad-form-field">
                  <Select
                    label={tr(label)}
                    {...status.deviceOptions(direction, values[key] ?? '')}
                    value={values[key] ?? ''}
                    onValueChange={(value) => onAudioCommit(key, value)}
                  />
                </Grid>
              ))}
              <Grid
                span={{ base: 'full', sm: 2 }}
                className="ad-form-field"
                data-custom=""
              >
                <Stack justify="center">
                  <FormButton
                    size="md"
                    icon="play"
                    label={tr('audioTestSound')}
                    onClick={() => void status.onPlayTestSound()}
                    disabled={!status.audioAvailable}
                  />
                </Stack>
              </Grid>
              {values.backend === 'ASIO' && (
                <Grid span="full" className="ad-form-field">
                  <Switch
                    label={tr('releaseAsioInBackground')}
                    checked={store.preferences.releaseAsioInBackground}
                    onValueChange={status.onReleaseAsioInBackgroundChange}
                  />
                </Grid>
              )}
            </Grid>
          </Card>
        </Grid>
      </>
    );
  },
);
