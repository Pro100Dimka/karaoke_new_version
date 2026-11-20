import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBridge } from './audioClientFixture';
import { audioClient } from './audioClient';
describe('audioClient contract', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktop');
    vi.restoreAllMocks();
  });

  it.each([true, false])(
    'restores the playing song and mix after changing room sample rate (media retained=%s)',
    async (retained) => {
      let sessionState = 'Running';
      let playbackFrames = 96_000;
      let runtimeRate = 48_000;
      let playbackState = 0;

      const { requests } = installBridge(
        (request) => {
          if (request.command === 'Reconfigure') {
            sessionState = 'Prepared';
            playbackFrames = 0;
            runtimeRate = Number(request.args?.rate) || runtimeRate;
            playbackState = retained ? 3 : 0;
          }
          if (request.command === 'LoadSong') playbackState = 2;
          if (request.command === 'Pause') playbackState = 4;
          if (request.command === 'Seek')
            playbackFrames = Number(request.args?.frame);
          if (request.command === 'Play') {
            if (playbackState === 3)
              return { status: 5, text: 'media is already playing' };
            playbackState = 3;
          }
          if (request.command === 'StartSession') sessionState = 'Running';
          return {
            status: 0,
            text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
              request.command,
            )
              ? `SessionState: ${sessionState}\nPlaybackState: ${playbackState}\nPlaybackPositionFrames: ${playbackFrames}\nRuntimeOutputSampleRate: ${runtimeRate}\nRuntimeOutputPeriodFrames: 256`
              : 'Ok',
          };
        },
        {
          joinRoomVoice: vi.fn(async () => undefined),
          leaveRoomVoice: vi.fn(async () => undefined),
          resolveProjectArtifacts: vi.fn(async () => ({
            instrumental: 'instrumental.wav',
            vocals: 'vocals.wav',
            melody: 'melody.wav',
          })),
        },
      );
      const song = {
        id: 'song',
        activeRevision: 2,
        durationSeconds: 180,
      } as never;
      audioClient.setPreferredConfiguration({
        backend: 'WASAPI Shared',
        sampleRate: 48000,
        periodFrames: 256,
      });
      await audioClient.leaveVoiceSession();
      await audioClient.joinVoiceSession('ROOM-1', 'self');
      await audioClient.prepareSong(song);
      await audioClient.setMixer('music', 0.7);
      await audioClient.play();
      await audioClient.seek(2);
      requests.length = 0;

      await audioClient.applyConfiguration({
        backend: 'WASAPI Shared',
        sampleRate: 44100,
        periodFrames: 512,
      });

      expect(requests).toEqual(
        expect.arrayContaining([
          {
            command: 'SetGain',
            args: { target: 'music', value: expect.closeTo(0.7 ** 3, 6) },
          },
          { command: 'Seek', args: { frame: 88_200 } },
          { command: 'Play', args: undefined },
        ]),
      );
      expect(requests.filter(({ command }) => command === 'LoadSong')).toEqual(
        retained
          ? []
          : [
              {
                command: 'LoadSong',
                args: expect.objectContaining({
                  instrumental: 'instrumental.wav',
                }),
              },
            ],
      );
      await audioClient.stop();
      await audioClient.leaveVoiceSession();
    },
  );

  it('keeps the scheduled room timeline across a slow sample-rate change', async () => {
    let now = 200;
    let rate = 48000;

    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { requests } = installBridge(
      (request) => {
        if (request.command === 'Reconfigure') {
          now += 2000;
          rate = Number(request.args?.rate);
        }
        return {
          status: 0,
          text:
            request.command === 'GetClock'
              ? `MonotonicTicks: ${(now + 800) * 1e6}`
              : ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
                    request.command,
                  )
                ? `SessionState: Running\nPlaybackState: 3\nPlaybackPositionFrames: 96000\nRuntimeOutputSampleRate: ${rate}\nMonotonicTicks: ${(now + 800) * 1e6}`
                : 'Ok',
        };
      },
      {
        joinRoomVoice: vi.fn(async () => undefined),
        leaveRoomVoice: vi.fn(async () => undefined),
        resolveProjectArtifacts: vi.fn(async () => ({
          instrumental: 'instrumental.wav',
        })),
      },
    );
    await audioClient.leaveVoiceSession();
    await audioClient.prepareSong({
      id: 'song',
      activeRevision: 1,
      durationSeconds: 180,
    } as never);
    await audioClient.play({ startAtMilliseconds: 700, positionSeconds: 2 });
    requests.length = 0;
    await audioClient.applyConfiguration({
      backend: 'WASAPI Shared',
      sampleRate: 44100,
      periodFrames: 441,
    });
    expect(requests.filter(({ command }) => command === 'Play').at(-1)).toEqual(
      {
        command: 'Play',
        args: { startAtTicks: 1_500_000_000, frame: 88_200 },
      },
    );
    await audioClient.stop();
  });

  it('serializes complete reconfigurations across settings lifetimes', async () => {
    let release!: () => void;
    const firstSwitch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { requests } = installBridge(async (request) => {
      if (
        request.command === 'Reconfigure' &&
        requests.filter((r) => r.command === 'Reconfigure').length === 1
      )
        await firstSwitch;
      return {
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
          request.command,
        )
          ? 'SessionState: Running\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: 48000'
          : 'Ok',
      };
    });
    await audioClient.stop();
    requests.length = 0;
    const first = audioClient.applyConfiguration({
      backend: 'WASAPI Shared',
      sampleRate: 48000,
      periodFrames: 480,
    });
    const second = audioClient.applyConfiguration({
      backend: 'WASAPI Exclusive',
      sampleRate: 48000,
      periodFrames: 480,
    });
    const capabilities = audioClient.configurationCapabilities({
      backend: 'WASAPI Shared',
      sampleRate: 48000,
      periodFrames: 480,
    });
    try {
      for (let turn = 0; turn < 30; turn++) await Promise.resolve();
      expect(requests.filter((r) => r.command === 'Reconfigure')).toHaveLength(
        1,
      );
      expect(requests.some((r) => r.command === 'GetAudioCapabilities')).toBe(
        false,
      );
    } finally {
      release();
      await Promise.all([first, second, capabilities]);
    }
  });

  it('restores current DSP values before monitoring becomes audible', async () => {
    const { requests } = installBridge((request) => {
      return {
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
          request.command,
        )
          ? 'SessionState: Running'
          : 'Ok',
      };
    });
    await audioClient.setDspParameter('reverb.mix', 0.42);
    await audioClient.setDspEnabled(true);
    requests.length = 0;

    await audioClient.setMonitoring(true);

    expect(
      requests.filter(({ command }) => command !== 'GetDiagnostics').slice(0, 3),
    ).toEqual([
      { command: 'SetDspParameter', args: { name: 'reverb.mix', value: 0.42 } },
      { command: 'SetDspEnabled', args: { enabled: true } },
      { command: 'SetMonitoring', args: { enabled: true } },
    ]);
  });

  it('restores voice processing after a device change without a loaded song', async () => {
    const { requests } = installBridge((request) => {
      return {
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
          request.command,
        )
          ? 'SessionState: Running\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: 48000'
          : 'Ok',
      };
    });
    await audioClient.stop();
    await audioClient.setDspParameter('reverb.mix', 0.42);
    await audioClient.setDspEnabled(true);
    requests.length = 0;
    await audioClient.applyConfiguration({
      backend: 'WASAPI Shared',
      sampleRate: 48000,
      periodFrames: 480,
      inputDeviceId: '',
      outputDeviceId: '',
    });
    expect(requests).toContainEqual({
      command: 'SetDspParameter',
      args: { name: 'reverb.mix', value: 0.42 },
    });
    expect(requests).toContainEqual({
      command: 'SetDspEnabled',
      args: { enabled: true },
    });
    expect(requests).not.toContainEqual(
      expect.objectContaining({ command: 'LoadSong' }),
    );
  });
});
