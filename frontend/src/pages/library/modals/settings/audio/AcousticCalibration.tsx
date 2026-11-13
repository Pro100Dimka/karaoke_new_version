import { observer } from 'mobx-react-lite';
import {
  Button,
  Stack,
  Tooltip,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import type { RuntimeAudioConfiguration } from '../../../../../contracts/models';
import { useAcousticCalibration } from './useAcousticCalibration';

/** Measures acoustic delay from test signals; the result does not identify its physical cause. */
export const AcousticCalibration = observer(
  ({
    audioAvailable,
    runtime,
  }: {
    audioAvailable: boolean;
    runtime: RuntimeAudioConfiguration;
  }) => {
    useLocale();
    const { measuring, measured, measuredHere, measure } =
      useAcousticCalibration(audioAvailable, runtime);
    // A measurement made right here is from test signals even before the runtime reports it.
    const sourceKey =
      runtime.calibratedLatencyMs === undefined || measuredHere
        ? 'latencySourceTestSignal'
        : runtime.calibrationOrigin === 'SONG'
          ? 'latencySourceSong'
          : runtime.calibrationOrigin === 'PROFILE'
            ? 'latencySourceProfile'
            : 'latencySourceTestSignal';
    return (
      <Stack gap={2}>
        <Stack direction="row" wrap align="center" justify="between" gap={3}>
          <Typography variant="caption" tone="muted">
            {measured === undefined
              ? tr('latencyPartAcousticUnknown')
              : tr('latencyPartAcoustic', {
                  value: Math.round(measured),
                  source: tr(sourceKey),
                })}
          </Typography>
          <Tooltip content={tr('acousticLatencyHint')}>
            <Button
              size="sm"
              icon="target"
              loading={measuring}
              disabled={!audioAvailable || measuring}
              onClick={() => void measure()}
            >
              {tr(
                measuring
                  ? 'acousticLatencyMeasuring'
                  : measured === undefined
                    ? 'acousticLatencyMeasure'
                    : 'acousticLatencyRecheck',
              )}
            </Button>
          </Tooltip>
        </Stack>
        {measured !== undefined && (
          <Typography variant="caption" tone="muted">
            {tr('acousticLatencyUncertaintyHint')}
          </Typography>
        )}
      </Stack>
    );
  },
);
