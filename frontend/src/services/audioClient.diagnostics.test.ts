import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBridge } from './audioClientFixture';
import { audioClient, getAudioSnapshot } from './audioClient';
import { roomTimingFromDiagnostics } from './audioProtocol';
describe('audioClient contract', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktop');
    vi.restoreAllMocks();
  });

  it('reports voice queue gaps and confirmed device underruns separately from clock pressure', () => {
    expect(
      roomTimingFromDiagnostics({
        RuntimeOutputSampleRate: '44100',
        RenderStarvedFrames: '873',
        RenderConfirmedUnderrunFrames: '128',
        RenderClockRebaseFrames: '0',
        'RemoteJitterMs.__room_server_mix__': '1.2',
        'RemoteDecodeUnderruns.__room_server_mix__': '30',
        'RemoteLostPackets.__room_server_mix__': '12',
      }),
    ).toMatchObject({
      deviceStarvedFrames: 128,
      remotes: {
        __room_server_mix__: { decodeUnderruns: 30, lostPackets: 12 },
      },
    });
  });

  it('preserves capture confidence and rejects impossible confidence values', async () => {
    installBridge(() => ({
      status: 0,
      text: [
        'RuntimeOutputSampleRate: 48000',
        'InputPitchEpoch: 2',
        'InputPitchHistory: 1,48000,2048,440,1,0.92|2,50048,2048,430,1,1.2',
      ].join('\n'),
    }));
    expect((await getAudioSnapshot()).pitchFrames).toMatchObject([
      { sequence: 1, pitchHz: 440, audioActive: true, confidence: 0.92 },
    ]);
  });

  it('preserves audible unpitched activity in captured frames', async () => {
    installBridge(() => ({
      status: 0,
      text: [
        'RuntimeOutputSampleRate: 48000',
        'InputPitchEpoch: 2',
        'InputPitchHistory: 1,48000,2048,0,1|2,50048,2048,0,0',
      ].join('\n'),
    }));
    expect((await getAudioSnapshot()).pitchFrames).toMatchObject([
      { sequence: 1, audioActive: true, pitchHz: undefined },
      { sequence: 2, audioActive: false, pitchHz: undefined },
    ]);
  });

  it('keeps capture-aligned pitch batches separate from the current playback cursor', async () => {
    installBridge(() => ({
      status: 0,
      text: [
        'RuntimeOutputSampleRate: 48000',
        'PlaybackState: Playing',
        'PlaybackPresentationPositionFrames: 480000',
        'InputPitchEpoch: 7',
        'InputPitchHistory: 51,470400,2048,440|52,472448,2048,0|broken',
      ].join('\n'),
    }));
    const value = await getAudioSnapshot();
    expect(value).toMatchObject({
      positionSeconds: 10,
      pitchFrames: [
        {
          sequence: 51,
          epoch: 7,
          positionSeconds: 9.8,
          durationSeconds: 2048 / 48000,
          pitchHz: 440,
        },
        {
          sequence: 52,
          epoch: 7,
          positionSeconds: 472448 / 48000,
          durationSeconds: 2048 / 48000,
        },
      ],
    });
  });

  it.each<[string, number | null]>([
    ['0', 0],
    ['100000', 10],
    ['-1', null],
  ])(
    "keeps the driver's own input latency apart from the assumed one (%s: %s)",
    async (hns, reported) => {
      installBridge(() => ({
        status: 0,
        text: [
          'RuntimeOutputSampleRate: 48000',
          `ReportedInputLatencyHns: ${hns}`,
          'LocalCaptureDeviceMs: 10',
          'LocalAudioServiceInternalMs: 2.5',
          'LocalResamplerDspMs: 0',
          'LocalRenderQueueMs: 10',
          'LocalEndpointOutputMs: 9.5',
        ].join('\n'),
      }));
      await expect(audioClient.runtimeConfiguration()).resolves.toMatchObject({
        latencyParts: {
          inputMs: 10,
          inputReportedMs: reported,
          outputMs: 19.5,
          appMs: 2.5,
        },
      });
    },
  );

  it('hands AudioService every saved device-path calibration and skips unverifiable old keys', async () => {
    // AudioService's own wording: diagnostics lines are also split at ';' by the parser.
    const path =
      'WASAPI Shared,{0.0.1.00000000}.{mic},{0.0.0.00000000}.{speaker},48000,48000,480,480,1056,1056';
    const other =
      'WASAPI Exclusive,{0.0.1.00000000}.{mic},{0.0.0.00000000}.{speaker},48000,48000,480,480,480,480';

    const { requests } = installBridge((request) => {
      if (['GetDiagnostics', 'GetPlaybackSnapshot'].includes(request.command))
        return {
          status: 0,
          text: `MonotonicTicks: 1\nAcousticCalibrationFingerprint: ${path}\nAcousticCalibrationValid: 0`,
        };
      return {
        status: 0,
        text:
          request.args?.fingerprint === path
            ? 'AcousticLatencyRestored'
            : 'AcousticLatencyRemembered',
      };
    });
    await expect(
      audioClient.rememberAcousticLatencies({
        [path]: 45.8,
        [other]: 17.6,
        'WASAPI Shared||': 45,
      }),
    ).resolves.toBe(true);
    expect(
      requests.filter(
        (request) => request.command === 'RememberAcousticLatency',
      ),
    ).toEqual([
      {
        command: 'RememberAcousticLatency',
        args: { ms: 45.8, fingerprint: path },
      },
      {
        command: 'RememberAcousticLatency',
        args: { ms: 17.6, fingerprint: other },
      },
    ]);
  });

  it.each([
    '',
    'EstimatedLatencyFrames: NaN',
    'EstimatedLatencyFrames: Infinity',
    'EstimatedLatencyFrames: -1',
    'EstimatedLatencyFrames: 0',
  ])(
    'does not turn missing or invalid latency into a measured zero: %s',
    async (latency) => {
      installBridge(() => ({
        status: 0,
        text: `RuntimeOutputSampleRate: 48000\n${latency}`,
      }));
      await expect(audioClient.runtimeConfiguration()).resolves.toMatchObject({
        estimatedLatencyMs: null,
      });
    },
  );

  it.each(['', '0', 'NaN', 'Infinity', '-48000'])(
    'leaves latency unknown without a valid runtime sample clock: %s',
    async (rate) => {
      installBridge(() => ({
        status: 0,
        text: `RuntimeOutputSampleRate: ${rate}\nEstimatedLatencyFrames: 1920`,
      }));
      await expect(audioClient.runtimeConfiguration()).resolves.toMatchObject({
        estimatedLatencyMs: null,
      });
    },
  );

  it('compares room timing with presented audio instead of the end of a queued device block', async () => {
    installBridge(() => ({
      status: 0,
      text: 'PlaybackState: 3\nPlaybackPositionFrames: 48500\nPlaybackPresentationPositionFrames: 48000\nRuntimeOutputSampleRate: 48000',
    }));
    await expect(getAudioSnapshot()).resolves.toMatchObject({
      positionSeconds: 1,
    });
  });

  it('reports room voice timing from live AudioService jitter and buffer diagnostics', async () => {
    installBridge(({ command }) => ({
      status: 0,
      text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
        ? [
            'RuntimeOutputSampleRate: 48000',
            'EstimatedLatencyFrames: 480',
            'NetworkRoundTripMs: 34',
            'NetworkPacketsSent: 1234',
            'NetworkPacketsReceived: 1200',
            'NetworkRelayEchoes: 31',
            'NetworkTransportRunning: 1',
            'NetworkSendEnabled: 1',
            'RemoteJitterMs.friend: 4.5',
            'RemoteTargetDelayFrames.friend: 1440',
            'RemoteRelayFirstPackets.friend: 12',
            'RemoteDirectFirstPackets.friend: 4000',
            'RemoteLateAudioCuts.friend: 2',
            'RemoteTimelineExcluded.friend: 0',
            'RoomCompensationFrames: 1920',
            'RoomRequestedDelayFrames: 2400',
            'RoomReturnRequirementFrames: 192',
            'RoomArrivalRequirementFrames: 480',
            'RoomPlayoutDelayFrames: 7680',
            'RoomFollowFrames: 1920',
          ].join('\n')
        : 'Ok',
    }));

    await expect(audioClient.roomTiming()).resolves.toEqual({
      roundTripMs: 34,
      deviceLatencyMs: 10,
      packetsSent: 1234,
      packetsReceived: 1200,
      relayEchoes: 31,
      networkTransportRunning: true,
      networkSendEnabled: true,
      remotes: {
        friend: {
          jitterMs: 4.5,
          targetDelayMs: 30,
          relayPackets: 12,
          directPackets: 4000,
          lateCuts: 2,
          excluded: false,
        },
      },
      estimatedVoiceLatencyMs: 27,
      requestedVoiceDelayMs: 50,
      returnRequirementMs: 4,
      arrivalRequirementMs: 10,
      roomPlayoutDelayMs: 160,
      voiceDelayMs: 40,
      followMs: 0,
      deviceStarvedFrames: 0,
    });
  });

  it('adds the submission period to measured Shared padding when runtime latency is unavailable', async () => {
    installBridge(({ command }) => ({
      status: 0,
      text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
        ? [
            'RuntimeOutputSampleRate: 48000',
            'RoomRequestedDelayFrames: 4608',
            'RoomVoiceRoute: direct',
            'OutputDriverLatencyFrames: 808',
            'RuntimeOutputLatencyFrames: 0',
            'RuntimeOutputPeriodFrames: 480',
          ].join('\n')
        : 'Ok',
    }));
    expect((await audioClient.roomTiming()).requestedVoiceDelayMs).toBeCloseTo(
      122.833333,
    );
  });

  it('does not invent a device sample rate when AudioService has not reported one', async () => {
    installBridge(({ command }) => ({
      status: 0,
      text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
        ? 'EstimatedLatencyFrames: 480\nRemoteJitterMs.friend: 5\nRemoteTargetDelayFrames.friend: 1440'
        : 'Ok',
    }));

    await expect(audioClient.roomTiming()).resolves.toEqual({
      roundTripMs: 0,
      deviceLatencyMs: 0,
      packetsSent: 0,
      packetsReceived: 0,
      relayEchoes: 0,
      networkTransportRunning: false,
      networkSendEnabled: false,
      remotes: {
        friend: {
          jitterMs: 5,
          targetDelayMs: 0,
          relayPackets: 0,
          directPackets: 0,
          lateCuts: 0,
        },
      },
      estimatedVoiceLatencyMs: 0,
      voiceDelayMs: 0,
      followMs: 0,
      deviceStarvedFrames: 0,
    });
  });
});
