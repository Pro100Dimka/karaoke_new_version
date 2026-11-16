import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBridge } from './audioClientFixture';
import { audioClient } from './audioClient';
describe('audioClient contract', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktop');
    vi.restoreAllMocks();
  });

  it('applies one server-owned room delay once and clears it when leaving', async () => {
    const { requests: commands } = installBridge(
      () => ({ status: 0, text: 'Ok' }),
      {
        leaveRoomVoice: vi.fn(async () => undefined),
      },
    );
    await audioClient.setRoomPlayoutDelay(84);
    await audioClient.setRoomPlayoutDelay(84);
    await audioClient.leaveVoiceSession();
    expect(
      commands
        .filter((item) => item.command === 'SetRoomPlayoutDelay')
        .map((item) => item.args?.milliseconds),
    ).toEqual([84, 0]);
  });

  it('brings a session running in another mode to the chosen mode before joining a room', async () => {
    const { commands } = installBridge(
      (request) => {
        return {
          status: 0,
          text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
            request.command,
          )
            ? 'SessionState: Running\nBackend: WASAPI Shared'
            : 'Ok',
        };
      },
      {
        joinRoomVoice: vi.fn(async () => void commands.push('joinRoomVoice')),
      },
    );
    audioClient.setPreferredConfiguration({
      backend: 'WASAPI Exclusive',
      sampleRate: 0,
      periodFrames: 0,
      bufferFrames: 480,
    });
    await audioClient.joinVoiceSession('ROOM-2', 'person-2');
    audioClient.setPreferredConfiguration({
      backend: 'WASAPI Shared',
      sampleRate: 0,
      periodFrames: 0,
    });
    expect(commands.indexOf('Reconfigure')).toBeGreaterThan(-1);
    expect(commands.indexOf('Reconfigure')).toBeLessThan(
      commands.lastIndexOf('joinRoomVoice'),
    );
  });

  it('registers voice with both the room and participant identity', async () => {
    const joinRoomVoice = vi.fn(async () => undefined);

    const { audioRequest } = installBridge(
      (request) => ({
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
          request.command,
        )
          ? 'SessionState: Prepared'
          : 'Ok',
      }),
      {
        joinRoomVoice,
      },
    );

    await audioClient.joinVoiceSession('ROOM-1', 'person-1');

    expect(joinRoomVoice).toHaveBeenCalledWith('ROOM-1', 'person-1');
    expect(audioRequest).toHaveBeenCalledWith({
      command: 'StartSession',
      args: undefined,
    });
  });

  it('exposes microphone and per-participant room levels', async () => {
    installBridge(({ command }) => ({
      status: 0,
      text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
        ? 'InputRMS: 0.2\nRemoteLevel.guest-1: 0.7'
        : 'Ok',
    }));

    await expect(audioClient.roomLevels()).resolves.toEqual({
      local: 0.2,
      remote: { 'guest-1': 0.7 },
    });
  });

  it('sets the continuous server clock before enabling room voice', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(200);
    const { commands } = installBridge(() => ({
      status: 0,
      text: 'SessionState: Running\nMonotonicTicks: 1000000000',
    }));
    const joinRoomVoice = vi.fn(async () => {
      expect(commands.at(-1)).toBe('SetRoomClock');
    });
    Object.assign(window.desktop!, { joinRoomVoice });
    await audioClient.joinVoiceSession('CLOCK-ROOM', 'self', 1_790_000_000_000);
    expect(window.desktop?.audioRequest).toHaveBeenCalledWith({
      command: 'SetRoomClock',
      args: {
        serverMicros: 1_790_000_000_200_000,
        localMicros: 1_000_000,
      },
    });
    expect(joinRoomVoice).toHaveBeenCalledOnce();
  });

  it('maps a renderer deadline onto the native monotonic clock before Play', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(200);
    installBridge(() => ({
      status: 0,
      text: 'MonotonicTicks: 1000000000\nRuntimeOutputSampleRate: 44100',
    }));
    await audioClient.play({ startAtMilliseconds: 700, positionSeconds: 3 });
    expect(window.desktop?.audioRequest).toHaveBeenCalledWith({
      command: 'Play',
      args: { startAtTicks: 1500000000, frame: 132300 },
    });
  });

  it('reserves output submission lead after socket arrival for room voice delivery', async () => {
    const { commands } = installBridge(({ command }) => ({
      status: 0,
      text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
        ? [
            'generationId: 42',
            'RuntimeOutputSampleRate: 48000',
            'RoomRequestedDelayFrames: 2784',
            'RoomReturnRequirementFrames: 864',
            'RoomArrivalRequirementFrames: 1800',
            'OutputDriverLatencyFrames: 960',
            'EstimatedLatencyFrames: 1488',
            'RoomPlayoutDelayFrames: 2880',
          ].join('\n')
        : 'Ok',
    }));

    await expect(audioClient.roomTiming()).resolves.toMatchObject({
      generationId: 42,
      requestedVoiceDelayMs: 78,
      returnRequirementMs: 38,
      arrivalRequirementMs: 37.5,
      roomPlayoutDelayMs: 60,
    });
    expect(commands).toEqual(['GetDiagnostics']);
  });

  it.each(['join', 'leave'] as const)(
    'preserves the selected Exclusive device when rooms %s',
    async (action) => {
      const { requests } = installBridge(
        (request) => {
          return {
            status: 0,
            text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
              request.command,
            )
              ? 'SessionState: Running'
              : 'Ok',
          };
        },
        {
          joinRoomVoice: vi.fn(async () => undefined),
          leaveRoomVoice: vi.fn(async () => undefined),
        },
      );
      audioClient.setPreferredConfiguration({
        backend: 'WASAPI Shared',
        sampleRate: 44100,
        periodFrames: 441,
      });
      await audioClient.leaveVoiceSession();
      audioClient.setPreferredConfiguration({
        backend: 'WASAPI Exclusive',
        sampleRate: 44100,
        periodFrames: 441,
      });
      const { audioState } = await import('./audioSession');
      audioState.active = audioClient.preferredConfiguration();
      if (action === 'leave')
        await audioClient.joinVoiceSession('ROOM-1', 'self');
      requests.length = 0;
      if (action === 'join')
        await audioClient.joinVoiceSession('ROOM-1', 'self');
      else await audioClient.leaveVoiceSession();
      expect(
        requests.filter((request) => request.command === 'Reconfigure'),
      ).toEqual([]);
    },
  );

  it.each([false, true])(
    'opens Exclusive with explicit Windows endpoints=%s while preserving room voice and peer gains',
    async (explicitEndpoints) => {
      const joinRoomVoice = vi.fn(async () => undefined);
      const leaveRoomVoice = vi.fn(async () => undefined);
      const setRoomVoiceParticipantGain = vi.fn(async () => undefined);
      const { requests } = installBridge(
        (request) => {
          return {
            status: 0,
            text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
              request.command,
            )
              ? 'SessionState: Running\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: 48000\nRuntimeOutputPeriodFrames: 256'
              : request.command === 'GetDevices'
                ? 'mic,Microphone,1,0,2\nspeaker,Speaker,1,1,2'
                : 'Ok',
          };
        },
        {
          joinRoomVoice,
          leaveRoomVoice,
          setRoomVoiceParticipantGain,
        },
      );
      audioClient.setPreferredConfiguration({
        backend: 'WASAPI Shared',
        sampleRate: 48000,
        periodFrames: 256,
      });
      await audioClient.leaveVoiceSession();
      requests.length = 0;
      joinRoomVoice.mockClear();
      setRoomVoiceParticipantGain.mockClear();

      await audioClient.joinVoiceSession('ROOM-1', 'self');
      await audioClient.addRemoteParticipant('friend');
      await audioClient.setParticipantVolume('friend', 0.42);
      expect(setRoomVoiceParticipantGain).toHaveBeenCalledWith('friend', 0.42);
      expect(requests).not.toContainEqual({
        command: 'SetRemoteGain',
        args: { participantId: 'friend', value: 0.42 },
      });
      requests.length = 0;
      joinRoomVoice.mockClear();
      setRoomVoiceParticipantGain.mockClear();

      await audioClient.applyConfiguration({
        backend: 'WASAPI Exclusive',
        sampleRate: 48000,
        periodFrames: 256,
        ...(explicitEndpoints && {
          inputDeviceId: 'mic',
          outputDeviceId: 'speaker',
        }),
      });

      expect(joinRoomVoice).toHaveBeenCalledWith('ROOM-1', 'self');
      expect(requests).toEqual(
        expect.arrayContaining([
          {
            command: 'Reconfigure',
            args: expect.objectContaining({ backend: 'wasapi-exclusive' }),
          },
          {
            command: 'AddRemoteParticipant',
            args: { participantId: '__room_server_mix__' },
          },
          {
            command: 'SetRemoteGain',
            args: { participantId: '__room_server_mix__', value: 1 },
          },
        ]),
      );
      expect(setRoomVoiceParticipantGain).toHaveBeenCalledWith('friend', 0.42);
      requests.length = 0;
      await audioClient.leaveVoiceSession();
      expect(
        requests.filter((request) => request.command === 'Reconfigure'),
      ).toEqual([]);
    },
  );

  it('restores room voice after a rejected driver switch so the previous backend keeps working', async () => {
    const joinRoomVoice = vi.fn(async () => undefined);
    let rejectReconfigure = false;
    let sessionState = 'Running';

    const { requests } = installBridge(
      (request) => {
        if (
          request.command === 'Reconfigure' &&
          rejectReconfigure &&
          request.args?.backend === 'asio'
        ) {
          sessionState = 'Failed';
          return { status: 5, text: 'exclusive render initialize failed' };
        }
        if (request.command === 'Reconfigure') sessionState = 'Prepared';
        if (request.command === 'StartSession') sessionState = 'Running';
        return {
          status: 0,
          text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
            request.command,
          )
            ? `SessionState: ${sessionState}\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: 48000\nRuntimeOutputPeriodFrames: 256`
            : 'Ok',
        };
      },
      {
        joinRoomVoice,
        leaveRoomVoice: vi.fn(async () => undefined),
      },
    );
    audioClient.setPreferredConfiguration({
      backend: 'WASAPI Shared',
      sampleRate: 48000,
      periodFrames: 256,
    });
    await audioClient.leaveVoiceSession();
    await audioClient.joinVoiceSession('ROOM-1', 'self');
    joinRoomVoice.mockClear();
    rejectReconfigure = true;

    await expect(
      audioClient.applyConfiguration({
        backend: 'ASIO',
        sampleRate: 48000,
        periodFrames: 256,
      }),
    ).rejects.toBeDefined();

    expect(joinRoomVoice).toHaveBeenCalledWith('ROOM-1', 'self');
    expect(requests.some((request) => request.command === 'StartSession')).toBe(
      true,
    );
  });

  it.each([
    [
      'sample rate',
      {
        backend: 'WASAPI Shared' as const,
        sampleRate: 44100,
        periodFrames: 256,
      },
    ],
    [
      'buffer size',
      {
        backend: 'WASAPI Shared' as const,
        sampleRate: 48000,
        periodFrames: 512,
      },
    ],
  ])(
    'restarts and re-registers room voice after changing %s',
    async (_label, configuration) => {
      const joinRoomVoice = vi.fn(async () => undefined);
      let sessionState = 'Running';

      const { requests } = installBridge(
        (request) => {
          if (request.command === 'Reconfigure') sessionState = 'Prepared';
          if (request.command === 'StartSession') sessionState = 'Running';
          return {
            status: 0,
            text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
              request.command,
            )
              ? `SessionState: ${sessionState}\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: ${configuration.sampleRate}\nRuntimeOutputPeriodFrames: ${configuration.periodFrames}`
              : 'Ok',
          };
        },
        {
          joinRoomVoice,
          leaveRoomVoice: vi.fn(async () => undefined),
        },
      );
      audioClient.setPreferredConfiguration({
        backend: 'WASAPI Shared',
        sampleRate: 48000,
        periodFrames: 256,
      });
      await audioClient.leaveVoiceSession();
      await audioClient.joinVoiceSession('ROOM-1', 'self');
      joinRoomVoice.mockClear();
      requests.length = 0;

      await audioClient.applyConfiguration(configuration);

      expect(requests).toContainEqual({
        command: 'StartSession',
        args: undefined,
      });
      expect(joinRoomVoice).toHaveBeenCalledWith('ROOM-1', 'self');
    },
  );
});
