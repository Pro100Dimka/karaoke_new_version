import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { tr } from '@neo-ui-kit/react';
import { ru } from '../../../../../i18n/messages.ru';
import LocalizationProvider from '../../../../../providers/localization';
import { audioClient } from '../../../../../services/audioClient';
import { runtimeConfigurationFromDiagnostics } from '../../../../../services/audioProtocol';
import AudioPanel from './index';
import { useAudioSettings } from './useAudioSettings';
import { useInputMonitoring } from './useInputMonitoring';

vi.mock('./useAudioSettings', () => ({ useAudioSettings: vi.fn() }));
vi.mock('./useInputMonitoring', () => ({ useInputMonitoring: vi.fn() }));
vi.mock('../../../../../services/audioClient', () => ({
  audioClient: { measureAcousticLatency: vi.fn() },
}));

let settings: ReturnType<typeof useAudioSettings>;
const setTestingInput = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  settings = {
    ready: true,
    audio: {
      values: {
        backend: 'WASAPI Shared',
        sampleRate: 48000,
        periodFrames: 480,
        bufferFrames: 480,
        inputDeviceId: '',
        outputDeviceId: '',
      },
      runtime: runtimeConfigurationFromDiagnostics({
        RuntimeOutputSampleRate: '48000',
        LocalObservedMonitoringMs: '34.125',
      }),
      options: { sampleRates: [], periods: [], inputPeriods: [] },
      deviceOptions: () => ({ error: undefined, options: [] }),
      devices: [],
      capabilities: { microphone: 'ready', keyboardLighting: false },
      configurationCapabilities: {
        sampleRates: [],
        periodFrames: [],
        defaultSampleRate: 48000,
        defaultPeriodFrames: 480,
      },
      configurationCapabilitiesBackend: 'WASAPI Shared',
      audioAvailable: true,
      asioUnavailable: false,
      asioReadyToRestart: false,
      releaseAsioInBackground: false,
      onPlayTestSound: vi.fn(async () => undefined),
      onAsioDriverDetected: vi.fn(),
      onOpenAsioControlPanel: vi.fn(),
      onReleaseAsioInBackgroundChange: vi.fn(),
      onAudioCommit: vi.fn(),
    },
  };
  vi.mocked(useAudioSettings).mockReturnValue(settings);
  vi.mocked(useInputMonitoring).mockReturnValue({
    inputLevel: 0.2,
    testingInput: false,
    canToggle: true,
    setTestingInput,
  });
});

it.each([undefined, 45.2])(
  'keeps calibration optional and separate from the displayed estimate (%s)',
  (calibratedLatencyMs) => {
    settings.audio.runtime.calibratedLatencyMs = calibratedLatencyMs;
    settings.audio.runtime.calibrationOrigin = 'PROFILE';
    render(<AudioPanel />, { wrapper: LocalizationProvider });
    const estimate = tr(ru.approximateMillisecondsValue, { value: 34 });
    expect(screen.getByText(estimate)).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: tr(ru.acousticLatencyMeasure) }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: tr(ru.acousticLatencyRecheck) }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: tr('audioLatencyHint') }),
    );
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText(estimate)).toBeVisible();
    expect(
      screen.getByRole('button', {
        name: tr(
          calibratedLatencyMs === undefined
            ? ru.acousticLatencyMeasure
            : ru.acousticLatencyRecheck,
        ),
      }),
    ).toBeVisible();
    expect(
      screen.queryByText(tr(ru.latencyActiveCorrection, { value: '45.20' })) !==
        null,
    ).toBe(calibratedLatencyMs !== undefined);
    expect(settings.audio.onPlayTestSound).not.toHaveBeenCalled();
    expect(audioClient.measureAcousticLatency).not.toHaveBeenCalled();
  },
);

it('changes only input monitoring when its control is selected', () => {
  render(<AudioPanel />, { wrapper: LocalizationProvider });
  fireEvent.click(screen.getByRole('button', { name: tr('inputMonitoring') }));
  expect(setTestingInput).toHaveBeenCalledExactlyOnceWith(true);
  expect(settings.audio.onAudioCommit).not.toHaveBeenCalled();
  expect(settings.audio.onPlayTestSound).not.toHaveBeenCalled();
  expect(audioClient.measureAcousticLatency).not.toHaveBeenCalled();
});
