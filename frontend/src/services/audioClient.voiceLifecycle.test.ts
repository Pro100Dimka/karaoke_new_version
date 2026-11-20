import { expect, it, vi } from 'vitest';
import { installBridge } from './audioVoiceFixture';

it.each([
  { room: false, tripped: false, observation: 'snapshot' },
  { room: true, tripped: false, observation: 'snapshot' },
  { room: false, tripped: true, observation: 'snapshot' },
  { room: true, tripped: true, observation: 'snapshot' },
  { room: false, tripped: true, observation: 'notification' },
  { room: true, tripped: true, observation: 'notification' },
])(
  'keeps observed monitoring intent across Windows reconfiguration: %j',
  async ({ room, tripped, observation }) => {
    let backend = 'WASAPI Shared';
    let monitoring = false;
    let safetyTripped = false;
    let sampleRate = 48_000;
    let notify: Parameters<DesktopApi['onAudioNotification']>[2] = () => {};
    const nativeSnapshot = () =>
      `SessionState: Running\nBackend: ${backend}\nMonitoringEnabled: ${Number(monitoring)}\nMonitoringSafetyTripped: ${Number(safetyTripped)}\nRuntimeOutputSampleRate: ${sampleRate}\nPlaybackState: 2`;
    const requests = installBridge(
      ({ command, args }) => {
        if (command === 'Reconfigure') {
          backend = args?.backend === 'wasapi-exclusive'
            ? 'WASAPI Exclusive' : 'WASAPI Shared';
          sampleRate = Number(args?.rate) || sampleRate;
          // Endpoint preparation resets the native monitor and its safety flag.
          monitoring = false;
          safetyTripped = false;
        }
        if (command === 'SetMonitoring') {
          monitoring = args?.enabled === true;
          if (monitoring) safetyTripped = false;
        }
        return {
          status: 0,
          text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
            ? nativeSnapshot() : 'Ok',
        };
      },
      {
        joinRoomVoice: vi.fn(async () => undefined),
        leaveRoomVoice: vi.fn(async () => undefined),
        onAudioNotification: (_command, _interval, listener) => {
          notify = listener;
          return () => {};
        },
      },
    );
    const { audioClient } = await import('./audioClient');
    const { waitForAudioOperations } = await import('./audioSession');
    audioClient.setPreferredConfiguration({
      backend: 'WASAPI Shared', sampleRate: 48_000, periodFrames: 0,
    });
    if (room) await audioClient.joinVoiceSession('room', 'self');
    await audioClient.setMonitoring(true);
    expect(monitoring).toBe(true);
    if (tripped) {
      monitoring = false;
      safetyTripped = true;
    }
    if (observation === 'notification') {
      const onValue = vi.fn();
      const onError = vi.fn();
      const unsubscribe = audioClient.observeSnapshots(onValue, onError);
      notify({ status: 0, text: `${nativeSnapshot()}\nMonotonicTicks: 1`, observedAt: 1 });
      await waitForAudioOperations();
      unsubscribe();
      expect(onError).not.toHaveBeenCalled();
      expect(onValue).toHaveBeenCalledWith(expect.objectContaining({ monitoring: false }));
    } else {
      expect((await audioClient.snapshot()).monitoring).toBe(!tripped);
    }
    requests.length = 0;
    await audioClient.applyConfiguration({
      backend: 'WASAPI Shared', sampleRate: 44_100, periodFrames: 0,
    });
    expect.soft((await audioClient.snapshot()).monitoring).toBe(!tripped);
    expect.soft(backend).toBe(room || !tripped ? 'WASAPI Exclusive' : 'WASAPI Shared');
    expect.soft(requests.filter(({ command }) => command === 'SetMonitoring')
      .map(({ args }) => args?.enabled)).toEqual([!tripped]);
    if (room) {
      await audioClient.leaveVoiceSession();
      expect.soft(backend).toBe(tripped ? 'WASAPI Shared' : 'WASAPI Exclusive');
    }
    // An explicit later request may enable monitoring again.
    await audioClient.setMonitoring(true);
    expect(monitoring).toBe(true);
    expect(backend).toBe('WASAPI Exclusive');
  },
);

it.each(['monitor-first', 'room-first'] as const)(
  'releases Exclusive only after both reasons end: %s',
  async (order) => {
    let backend = 'WASAPI Shared';
    let monitoring = false;
    const requests = installBridge(
      ({ command, args }) => {
        if (command === 'Reconfigure')
          backend =
            args?.backend === 'wasapi-exclusive'
              ? 'WASAPI Exclusive'
              : 'WASAPI Shared';
        if (command === 'SetMonitoring') monitoring = args?.enabled === true;
        return {
          status: 0,
          text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
            ? `SessionState: Running\nBackend: ${backend}\nMonitoringEnabled: ${Number(monitoring)}\nRuntimeOutputSampleRate: 48000`
            : 'Ok',
        };
      },
      {
        joinRoomVoice: vi.fn(async () => undefined),
        leaveRoomVoice: vi.fn(async () => undefined),
      },
    );
    const { audioClient } = await import('./audioClient');
    if (order === 'monitor-first') {
      await audioClient.setMonitoring(true);
      await audioClient.joinVoiceSession('room', 'self');
      await audioClient.setMonitoring(false);
      expect(backend).toBe('WASAPI Exclusive');
      await audioClient.reconnectVoiceSession();
      expect(backend).toBe('WASAPI Exclusive');
      await audioClient.leaveVoiceSession();
    } else {
      await audioClient.joinVoiceSession('room', 'self');
      await audioClient.setMonitoring(true);
      await audioClient.leaveVoiceSession();
      expect(backend).toBe('WASAPI Exclusive');
      await audioClient.setMonitoring(false);
    }
    expect(backend).toBe('WASAPI Shared');
    expect(
      requests
        .filter((r) => r.command === 'Reconfigure')
        .map((r) => r.args?.backend),
    ).toEqual(['wasapi-exclusive', 'wasapi-shared']);
  },
);

it('rolls back a failed room join and serializes rapid monitoring cleanup', async () => {
  let backend = 'WASAPI Shared';
  const requests = installBridge(
    ({ command, args }) => {
      if (command === 'Reconfigure')
        backend =
          args?.backend === 'wasapi-exclusive'
            ? 'WASAPI Exclusive'
            : 'WASAPI Shared';
      return {
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
          ? `SessionState: Running\nBackend: ${backend}\nRuntimeOutputSampleRate: 48000`
          : 'Ok',
      };
    },
    {
      joinRoomVoice: vi.fn(async () => {
        throw new Error('Join failed');
      }),
      leaveRoomVoice: vi.fn(async () => undefined),
    },
  );
  const { audioClient } = await import('./audioClient');
  await expect(audioClient.joinVoiceSession('room', 'self')).rejects.toThrow(
    'Join failed',
  );
  expect(backend).toBe('WASAPI Shared');
  requests.length = 0;
  await Promise.all([
    audioClient.setMonitoring(true),
    audioClient.setMonitoring(false),
  ]);
  expect(backend).toBe('WASAPI Shared');
  expect(
    requests
      .filter((r) => r.command === 'Reconfigure')
      .map((r) => r.args?.backend),
  ).toEqual(['wasapi-exclusive', 'wasapi-shared']);
});

it('releases the Windows mode even if failed-join cleanup is rejected', async () => {
  let backend = 'WASAPI Shared';
  installBridge(
    ({ command, args }) => {
      if (command === 'Reconfigure')
        backend =
          args?.backend === 'wasapi-exclusive'
            ? 'WASAPI Exclusive'
            : 'WASAPI Shared';
      return {
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
          ? `SessionState: Running\nBackend: ${backend}\nRuntimeOutputSampleRate: 48000`
          : 'Ok',
      };
    },
    {
      joinRoomVoice: vi.fn(async () => {
        throw new Error('Join failed');
      }),
      leaveRoomVoice: vi.fn(async () => {
        throw new Error('Cleanup failed');
      }),
    },
  );
  const { audioClient } = await import('./audioClient');
  await expect(audioClient.joinVoiceSession('room', 'self')).rejects.toThrow(
    'Cleanup failed',
  );
  expect(backend).toBe('WASAPI Shared');
});

it('preserves the selected configuration when recording cannot pause for a switch', async () => {
  installBridge(
    ({ command }) => ({
      status: command === 'PauseRecording' ? 5 : 0,
      text:
        command === 'PauseRecording'
          ? 'Pause rejected'
          : command === 'GetDevices'
            ? 'asio,Audient Driver,3,0,2\nasio,Audient Driver,3,1,2'
            : ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
              ? 'SessionState: Running\nBackend: WASAPI Shared\nRuntimeOutputSampleRate: 48000'
              : 'Ok',
    }),
    {
      pythonRequest: vi.fn(async (request) => ({
        ok: true,
        status: 200,
        body:
          request.path === '/recordings/target'
            ? { recordingId: 'take', filePath: 'D:/take.wav' }
            : {},
      })),
    },
  );
  const { audioClient } = await import('./audioClient');
  const { recordingCoordinator } = await import('./recordingCoordinator');
  const previous = audioClient.preferredConfiguration();
  await recordingCoordinator.start({
    id: 'song',
    activeRevision: 1,
    title: 'Song',
    artist: 'Artist',
    language: 'Auto',
    status: 'ready',
    durationSeconds: 1,
    createdAt: '2026-11-03',
    coverState: 'Fallback',
    projectFormatVersion: 1,
  });
  try {
    await expect(
      audioClient.applyConfiguration({
        backend: 'ASIO',
        userSelectedAsio: true,
        inputDeviceId: 'asio',
        outputDeviceId: 'asio',
        sampleRate: 48000,
        periodFrames: 0,
      }),
    ).rejects.toThrow('Pause rejected');
    expect(audioClient.preferredConfiguration()).toEqual(previous);
  } finally {
    recordingCoordinator.interrupt();
    await recordingCoordinator.stop();
  }
});

it('restores the server mix slot after every room voice session recreation', async () => {
  const requests = installBridge(undefined, {
    joinRoomVoice: vi.fn(async () => undefined),
    leaveRoomVoice: vi.fn(async () => undefined),
  });
  const { audioClient } = await import('./audioClient');
  const expectServerMixRestored = () =>
    expect(requests).toContainEqual({
      command: 'AddRemoteParticipant',
      args: { participantId: '__room_server_mix__' },
    });

  await audioClient.joinVoiceSession('room', 'self');
  expectServerMixRestored();

  requests.length = 0;
  await audioClient.joinVoiceSession('room', 'self');
  expectServerMixRestored();

  requests.length = 0;
  await audioClient.reconnectVoiceSession();
  expectServerMixRestored();

  requests.length = 0;
  await audioClient.applyConfiguration({
    backend: 'WASAPI Shared',
    sampleRate: 48_000,
    periodFrames: 256,
  });
  expectServerMixRestored();

  requests.length = 0;
  await audioClient.leaveVoiceSession();
  await audioClient.joinVoiceSession('room', 'self');
  expectServerMixRestored();
});

it('restores personal participant gain and effects after reconnect without recreating a nonexistent client slot', async () => {
  const joinRoomVoice = vi.fn(async () => undefined);
  const setRoomVoiceParticipantGain = vi.fn(async () => undefined);
  const setRoomVoiceParticipantEffect = vi.fn(async () => undefined);
  const requests = installBridge(undefined, {
    joinRoomVoice,
    setRoomVoiceParticipantGain,
    setRoomVoiceParticipantEffect,
  });
  const { audioClient } = await import('./audioClient');
  await audioClient.joinVoiceSession('room', 'self');
  expect(audioClient.participantVolume('friend')).toBe(2);
  await audioClient.setParticipantVolume('friend', 4);
  const effects = [
    ['reverb', 0.35],
    ['echo', 0.2],
    ['delay', 0.1],
    ['noiseSuppression', 1],
    ['octave', -1],
    ['autoTune', 0.4],
  ] as const;
  for (const [effect, value] of effects)
    await audioClient.setParticipantEffect('friend', effect, value);
  expect(
    requests.some((request) => request.command === 'SetRemoteEffect'),
  ).toBe(false);
  requests.length = 0;
  setRoomVoiceParticipantGain.mockClear();
  setRoomVoiceParticipantEffect.mockClear();
  await audioClient.reconnectVoiceSession();
  expect(setRoomVoiceParticipantGain).toHaveBeenCalledExactlyOnceWith(
    'friend',
    4,
  );
  expect(setRoomVoiceParticipantEffect).toHaveBeenCalledTimes(effects.length);
  for (const [effect, value] of effects)
    expect(setRoomVoiceParticipantEffect).toHaveBeenCalledWith(
      'friend',
      effect,
      value,
    );
  expect(
    requests.some((request) => request.command === 'SetRemoteEffect'),
  ).toBe(false);
  expect(
    requests.filter((request) => request.command === 'AddRemoteParticipant'),
  ).toEqual([
    {
      command: 'AddRemoteParticipant',
      args: { participantId: '__room_server_mix__' },
    },
  ]);
});

it('does not carry a muted personal mix into a newly joined room', async () => {
  const setRoomVoiceParticipantGain = vi.fn(async () => undefined);
  installBridge(undefined, {
    joinRoomVoice: vi.fn(async () => undefined),
    leaveRoomVoice: vi.fn(async () => undefined),
    setRoomVoiceParticipantGain,
  });
  const { audioClient } = await import('./audioClient');

  await audioClient.joinVoiceSession('old-room', 'self');
  const microphoneEnabled = audioClient.microphoneEnabled();
  await audioClient.setParticipantVolume('host', 0.42);
  await audioClient.setParticipantMuted('host', true);
  expect(setRoomVoiceParticipantGain).toHaveBeenLastCalledWith('host', 0);
  expect(audioClient.participantMuted('host')).toBe(true);
  expect(audioClient.microphoneEnabled()).toBe(microphoneEnabled);
  await audioClient.setParticipantMuted('host', false);
  expect(setRoomVoiceParticipantGain).toHaveBeenLastCalledWith('host', 0.42);
  expect(audioClient.participantMuted('host')).toBe(false);
  await audioClient.setParticipantMuted('host', true);
  await audioClient.leaveVoiceSession();
  setRoomVoiceParticipantGain.mockClear();

  await audioClient.joinVoiceSession('new-room', 'self');

  expect(setRoomVoiceParticipantGain).not.toHaveBeenCalledWith('host', 0);
  expect(audioClient.participantMuted('host')).toBe(false);
});

it.each([
  ['WASAPI Shared', 'ASIO'],
  ['ASIO', 'WASAPI Shared'],
  ['WASAPI Exclusive', 'ASIO'],
  ['ASIO', 'WASAPI Exclusive'],
] as const)(
  'preserves room voice and the server mix across %s to %s',
  async (from, to) => {
    const code = (backend: typeof from | typeof to) =>
      backend === 'ASIO'
        ? 'asio'
        : backend === 'WASAPI Exclusive'
          ? 'wasapi-exclusive'
          : 'wasapi-shared';
    const configuration = (backend: typeof from | typeof to) => ({
      backend,
      inputDeviceId: `${code(backend)}-device`,
      outputDeviceId: `${code(backend)}-device`,
      sampleRate: backend === 'ASIO' ? 44_100 : 48_000,
      periodFrames: backend === 'WASAPI Shared' ? 512 : 0,
      bufferFrames: backend === 'WASAPI Shared' ? undefined : 128,
    });
    let actual = from;
    let generation = 3;
    let networkGeneration = 1;
    let serverMixRegistered = false;
    const joinRoomVoice = vi.fn(async () => {
      networkGeneration += 1;
      serverMixRegistered = false;
    });

    const requests = installBridge(
      (request) => {
        if (request.command === 'Reconfigure') {
          actual =
            request.args?.backend === 'asio'
              ? 'ASIO'
              : request.args?.backend === 'wasapi-exclusive'
                ? 'WASAPI Exclusive'
                : 'WASAPI Shared';
          generation += 1;
        }
        if (request.command === 'AddRemoteParticipant')
          serverMixRegistered = true;
        return {
          status: 0,
          text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
            request.command,
          )
            ? [
                'SessionState: Running',
                `Backend: ${actual}`,
                `generationId: ${generation}`,
                `NetworkGeneration: ${networkGeneration}`,
                `ActiveOutputDeviceId: ${code(actual)}-device`,
                `RuntimeOutputSampleRate: ${actual === 'ASIO' ? 44_100 : 48_000}`,
                `RuntimeOutputPeriodFrames: ${actual === 'WASAPI Shared' ? 512 : 128}`,
                `RemoteDecodedPeak.__room_server_mix__: ${serverMixRegistered ? 0.2 : 0}`,
                `RemoteQueuedPeak.__room_server_mix__: ${serverMixRegistered ? 0.2 : 0}`,
                `RemoteRenderedPeak.__room_server_mix__: ${serverMixRegistered ? 0.2 : 0}`,
                `MasterOutputPeak: ${serverMixRegistered ? 0.2 : 0}`,
              ].join('\n')
            : request.command === 'GetDevices'
              ? ['WASAPI Shared', 'WASAPI Exclusive', 'ASIO']
                  .flatMap((item) => {
                    const itemCode = code(item as typeof from | typeof to);
                    const backend =
                      item === 'ASIO' ? 3 : item === 'WASAPI Exclusive' ? 2 : 1;
                    return [
                      `${itemCode}-device,Input,${backend},0,2`,
                      `${itemCode}-device,Output,${backend},1,2`,
                    ];
                  })
                  .join('\n')
              : 'Ok',
        };
      },
      {
        joinRoomVoice,
      },
    );
    const { audioClient } = await import('./audioClient');
    audioClient.setPreferredConfiguration(configuration(from));
    await audioClient.joinVoiceSession('room', 'self');
    requests.length = 0;

    await audioClient.applyConfiguration(configuration(to));
    const diagnostics = await audioClient.diagnosticsDump();

    expect(audioClient.preferredConfiguration().backend).toBe(to);
    const effective = to === 'WASAPI Shared' ? 'WASAPI Exclusive' : to;
    expect(diagnostics).toMatchObject({
      Backend: effective,
      ActiveOutputDeviceId: `${code(effective)}-device`,
      'RemoteDecodedPeak.__room_server_mix__': '0.2',
      'RemoteQueuedPeak.__room_server_mix__': '0.2',
      'RemoteRenderedPeak.__room_server_mix__': '0.2',
      MasterOutputPeak: '0.2',
    });
    expect(joinRoomVoice).toHaveBeenCalledTimes(2);
    expect(requests).toContainEqual({
      command: 'AddRemoteParticipant',
      args: { participantId: '__room_server_mix__' },
    });
  },
);
