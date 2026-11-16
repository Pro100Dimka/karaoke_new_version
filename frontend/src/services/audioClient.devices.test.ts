import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBridge } from './audioClientFixture';
import { audioClient } from './audioClient';
import { audioOptions } from '../pages/library/modals/settings/audio/audioOptions';
describe('audioClient contract', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktop');
    vi.restoreAllMocks();
  });

  it('uses Windows Exclusive for monitoring and returns to Shared after the last reason ends', async () => {
    const { audioState } = await import('./audioSession');
    let backend = 'WASAPI Shared';
    const { requests } = installBridge(({ command, args }) => {
      if (command === 'Reconfigure')
        backend =
          args?.backend === 'wasapi-exclusive'
            ? 'WASAPI Exclusive'
            : 'WASAPI Shared';
      return {
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
          ? `SessionState: Running\nBackend: ${backend}\nRuntimeOutputSampleRate: 48000\nRuntimeOutputPeriodFrames: 480`
          : 'Ok',
      };
    });
    audioState.preferred = {
      backend: 'WASAPI Shared',
      sampleRate: 48000,
      periodFrames: 0,
    };
    audioState.active = audioState.preferred;
    audioState.reconfiguration.song = null;
    await audioClient.setMonitoring(true);
    expect(backend).toBe('WASAPI Exclusive');
    expect(
      requests.find((r) => r.command === 'Reconfigure')?.args?.period,
    ).toBe(0);
    await audioClient.setMonitoring(false);
    expect(backend).toBe('WASAPI Shared');
    expect(
      requests
        .filter((r) => r.command === 'Reconfigure')
        .map((r) => r.args?.backend),
    ).toEqual(['wasapi-exclusive', 'wasapi-shared']);
  });

  it.each(['RuntimeOutputSampleRate: 0', ''])(
    'uses actual endpoint capacity and never substitutes the requested rate for runtime: %s',
    async (runtimeRate) => {
      installBridge(() => ({
        status: 0,
        text: [
          'RequestedSampleRate: 96000',
          runtimeRate,
          'RuntimeOutputPeriodFrames: 480',
          'RuntimeOutputEndpointBufferFrames: 2048',
          'RenderPaddingFrames: 120',
        ].join('\n'),
      }));
      await expect(audioClient.runtimeConfiguration()).resolves.toMatchObject({
        sampleRate: 0,
        endpointBufferFrames: 2048,
      });
    },
  );

  it('does not report a zero-channel capture endpoint as a usable microphone', async () => {
    installBridge(() => ({
      status: 0,
      text: 'stale-input,Microphone,1,0,0\nactive-output,Speakers,1,1,2\n',
    }));
    await expect(audioClient.capabilities()).resolves.toMatchObject({
      microphone: 'missing',
    });
  });

  it.each([
    ['Prepared', ['GetDiagnostics', 'StartSession', 'PlayOutputTest']],
    [
      'Prepared\nBackend: WASAPI Exclusive',
      [
        'GetDiagnostics',
        'StopSession',
        'GetDevices',
        'PrepareSession',
        'StartSession',
        'PlayOutputTest',
      ],
    ],
    [
      'Failed',
      [
        'GetDiagnostics',
        'StopSession',
        'GetDevices',
        'PrepareSession',
        'StartSession',
        'PlayOutputTest',
      ],
    ],
    ['Running', ['GetDiagnostics', 'PlayOutputTest']],
  ])(
    'brings a %s session to Running without preparing twice',
    async (sessionState, expected) => {
      const { commands } = installBridge(({ command }) => ({
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
          ? `SessionState: ${sessionState}`
          : command === 'GetDevices'
            ? ''
            : 'Ok',
      }));
      await audioClient.playTestSound();
      expect(commands).toEqual(expected);
    },
  );

  it('falls back to system audio when a saved device is absent on this computer', async () => {
    const { requests } = installBridge((request) => {
      return {
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
          request.command,
        )
          ? 'SessionState: Idle\nBackend: WASAPI Shared'
          : request.command === 'GetDevices'
            ? 'default-mic,Microphone,1,0,2\ndefault-speakers,Speakers,1,1,2'
            : 'Ok',
      };
    });
    audioClient.setPreferredConfiguration({
      backend: 'ASIO',
      inputDeviceId: 'asio-from-another-computer',
      outputDeviceId: 'asio-from-another-computer',
      sampleRate: 44100,
      periodFrames: 0,
      bufferFrames: 64,
    });

    await audioClient.playTestSound();

    expect(requests).toContainEqual({
      command: 'PrepareSession',
      args: expect.objectContaining({
        backend: 'wasapi-shared',
        input: undefined,
        output: undefined,
        rate: 0,
        period: 0,
      }),
    });
    audioClient.setPreferredConfiguration({
      backend: 'WASAPI Shared',
      sampleRate: 0,
      periodFrames: 0,
    });
  });

  it('sends a shared period and an exclusive/ASIO buffer as different settings', async () => {
    const { requests } = installBridge(
      (request) => {
        return {
          status: 0,
          text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
            request.command,
          )
            ? 'SessionState: Running\nRuntimeOutputSampleRate: 48000\nRuntimeOutputPeriodFrames: 256'
            : 'Ok',
        };
      },
      {
        joinRoomVoice: vi.fn(async () => undefined),
        leaveRoomVoice: vi.fn(async () => undefined),
      },
    );
    await audioClient.leaveVoiceSession();
    requests.length = 0;

    await audioClient.applyConfiguration({
      backend: 'WASAPI Shared',
      sampleRate: 48000,
      periodFrames: 480,
      inputPeriodFrames: 128,
      bufferFrames: 128,
    });
    expect(requests).toContainEqual({
      command: 'Reconfigure',
      args: expect.objectContaining({
        backend: 'wasapi-shared',
        period: 480,
        inputPeriod: 128,
      }),
    });

    requests.length = 0;
    await audioClient.applyConfiguration({
      backend: 'WASAPI Exclusive',
      sampleRate: 48000,
      periodFrames: 480,
      bufferFrames: 128,
    });
    expect(requests).toContainEqual({
      command: 'Reconfigure',
      args: expect.objectContaining({
        backend: 'wasapi-exclusive',
        period: 128,
      }),
    });
  });

  it('carries endpoint periods through IPC selection and a locked runtime into the UI', async () => {
    const replies: Record<string, string> = {
      GetAudioCapabilities: [
        'sampleRatesHz=48000',
        'periodFrames=128,160,480',
        'defaultSampleRateHz=48000',
        'defaultPeriodFrames=480',
        'periodSelectionReason=AVAILABLE',
      ].join('\n'),
      GetDevices: 'mic,Microphone,1,0,1\nphones,Headphones,1,1,2',
      GetDiagnostics: [
        'SessionState: Running',
        'Backend: WASAPI Shared',
        'RuntimeOutputSampleRate: 48000',
        'RuntimeOutputPeriodFrames: 480',
        'SelectedPeriodFrames: 128',
        'RequestedPeriodFrames: 128',
        'SharedEnginePeriodicityLocked: 1',
        'RuntimeOutputEndpointBufferFrames: 960',
      ].join('\n'),
    };
    const { requests } = installBridge((request) => {
      return { status: 0, text: replies[request.command] ?? 'Ok' };
    });
    const configuration = {
      backend: 'WASAPI Shared' as const,
      sampleRate: 48000,
      periodFrames: 128,
      inputDeviceId: 'mic',
      outputDeviceId: 'phones',
    };
    const capabilities =
      await audioClient.configurationCapabilities(configuration);
    const runtime = await audioClient.applyConfiguration(configuration);
    const options = audioOptions({
      values: { ...configuration, bufferFrames: 0 },
      runtime,
      configurationCapabilities: capabilities,
    });
    for (const command of ['GetAudioCapabilities', 'Reconfigure'])
      expect(requests).toContainEqual({
        command,
        args: expect.objectContaining({
          input: 'mic',
          output: 'phones',
          rate: 48000,
          period: 128,
        }),
      });
    expect(options.periods.map((option) => option.value)).toEqual([
      128, 160, 480,
    ]);
  });

  it('lets AudioService negotiate channels and preserves a requested small ASIO buffer', async () => {
    const { requests } = installBridge((request) => {
      return {
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
          request.command,
        )
          ? 'SessionState: Running\nRuntimeOutputSampleRate: 44100\nRuntimeOutputPeriodFrames: 8'
          : request.command === 'GetDevices'
            ? 'selected-asio,ASIO Driver,3,0,2\nselected-asio,ASIO Driver,3,1,2'
            : 'Ok',
      };
    });

    await audioClient.applyConfiguration({
      backend: 'ASIO',
      inputDeviceId: 'selected-asio',
      outputDeviceId: 'selected-asio',
      sampleRate: 44100,
      periodFrames: 8,
      bufferFrames: 8,
    });

    expect(
      requests.filter((request) => request.command === 'GetDevices'),
    ).toHaveLength(1);
    expect(requests).toContainEqual({
      command: 'Reconfigure',
      args: expect.objectContaining({
        backend: 'asio',
        inChannels: 0,
        outChannels: 0,
        period: 8,
      }),
    });
  });

  it("preserves the driver's preferred period independently of enumeration order", async () => {
    installBridge(() => ({
      status: 0,
      text: 'sampleRatesHz=44100\nperiodFrames=104,8,56\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=56',
    }));
    await expect(
      audioClient.configurationCapabilities({
        backend: 'ASIO',
        sampleRate: 0,
        periodFrames: 0,
      }),
    ).resolves.toMatchObject({
      defaultPeriodFrames: 56,
      periodFrames: [8, 56, 104],
    });
  });

  it('keeps the driver origin for a linear buffer range', async () => {
    installBridge(() => ({
      status: 0,
      text: 'sampleRatesHz=44100\nminPeriodFrames=8\nmaxPeriodFrames=104\nfundamentalPeriodFrames=16\ndefaultSampleRateHz=44100\ndefaultPeriodFrames=56',
    }));
    await expect(
      audioClient.configurationCapabilities({
        backend: 'ASIO',
        sampleRate: 0,
        periodFrames: 0,
      }),
    ).resolves.toMatchObject({
      defaultPeriodFrames: 56,
      periodFrames: [8, 24, 40, 56, 72, 88, 104],
    });
  });

  it('reserves a complete output period for direct voice rather than the last sampled padding', async () => {
    installBridge(({ command }) => ({
      status: 0,
      text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
        ? [
            'RuntimeOutputSampleRate: 48000',
            'RoomRequestedDelayFrames: 4608',
            'RoomVoiceRoute: direct',
            'OutputDriverLatencyFrames: 240',
            'RuntimeOutputLatencyFrames: 240',
            'RuntimeOutputPeriodFrames: 240',
          ].join('\n')
        : 'Ok',
    }));
    expect((await audioClient.roomTiming()).requestedVoiceDelayMs).toBe(106);
  });

  it('blocks ASIO4ALL monitoring before sending any audible output to an unverified route', async () => {
    const { requests } = installBridge((request) => {
      return {
        status: 0,
        text:
          request.command === 'GetDevices'
            ? 'asio4all,ASIO4ALL v2,3,0,0\nasio4all,ASIO4ALL v2,3,1,0\nspeakers,Speaker (Realtek),1,1,2'
            : ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
                  request.command,
                )
              ? 'SessionState: Running\nBackend: ASIO\nMonitoringEnabled: 0'
              : 'Ok',
      };
    });
    const { audioState } = await import('./audioSession');
    const previous = audioState.active;
    audioState.active = {
      backend: 'ASIO',
      inputDeviceId: 'asio4all',
      outputDeviceId: 'asio4all',
      sampleRate: 48_000,
      periodFrames: 0,
    };
    try {
      await expect(audioClient.setMonitoring(true)).rejects.toThrow(/ASIO4ALL/);
      expect(requests).not.toContainEqual({
        command: 'SetMonitoring',
        args: { enabled: true },
      });
      expect(requests).not.toContainEqual(
        expect.objectContaining({ command: 'SetDspEnabled' }),
      );
    } finally {
      audioState.active = previous;
    }
  });

  it('enables cautious ASIO4ALL monitoring when a physical microphone channel is present', async () => {
    const { requests } = installBridge((request) => {
      return {
        status: 0,
        text:
          request.command === 'GetDevices'
            ? 'asio4all,ASIO4ALL v2,3,0,0\nasio4all,ASIO4ALL v2,3,1,0'
            : ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
                  request.command,
                )
              ? 'SessionState: Running\nBackend: ASIO\nAsioInputChannelName.0: HD Audio Mic input 1\nAsioInputChannelRms.0: 0\nAsioInputChannelName.1: Wave Microphone - 0 1\nAsioInputChannelRms.1: 0.0002\nMonitoringEnabled: 0'
              : 'Ok',
      };
    });
    const { audioState } = await import('./audioSession');
    const previous = audioState.active;
    audioState.active = {
      backend: 'ASIO',
      inputDeviceId: 'asio4all',
      outputDeviceId: 'asio4all',
      sampleRate: 48_000,
      periodFrames: 512,
    };
    try {
      await audioClient.setMonitoring(true);
      expect(requests).toContainEqual({
        command: 'SetMonitoring',
        args: { enabled: true, safety: 'asio4all' },
      });
    } finally {
      audioState.active = previous;
      audioState.monitoring = false;
    }
  });
});
