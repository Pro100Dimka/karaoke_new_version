import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const installBridge = (
  reply: (
    request: AudioBridgeRequest,
  ) => AudioBridgeResponse | Promise<AudioBridgeResponse> = ({ command }) => ({
    status: 0,
    text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
      ? 'SessionState: Running'
      : 'Ok',
  }),
  desktop: Partial<Omit<DesktopApi, 'audioRequest'>> = {},
) => {
  const requests: AudioBridgeRequest[] = [];
  Object.assign(window, {
    desktop: {
      ...desktop,
      audioRequest: vi.fn(async (request: AudioBridgeRequest) => {
        requests.push(request);
        return reply(request);
      }),
    },
  });
  return requests;
};

beforeEach(() => vi.resetModules());
afterEach(() => Reflect.deleteProperty(window, 'desktop'));

it.each(['monitor-first', 'room-first'] as const)('releases Exclusive only after both reasons end: %s', async (order) => {
  let backend = 'WASAPI Shared';
  let monitoring = false;
  const requests = installBridge(({ command, args }) => {
    if (command === 'Reconfigure')
      backend = args?.backend === 'wasapi-exclusive' ? 'WASAPI Exclusive' : 'WASAPI Shared';
    if (command === 'SetMonitoring') monitoring = args?.enabled === true;
    return { status: 0, text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
      ? `SessionState: Running\nBackend: ${backend}\nMonitoringEnabled: ${Number(monitoring)}\nRuntimeOutputSampleRate: 48000`
      : 'Ok' };
  }, { joinRoomVoice: vi.fn(async () => undefined), leaveRoomVoice: vi.fn(async () => undefined) });
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
  expect(requests.filter(r => r.command === 'Reconfigure').map(r => r.args?.backend))
    .toEqual(['wasapi-exclusive', 'wasapi-shared']);
});

it('rolls back a failed room join and serializes rapid monitoring cleanup', async () => {
  let backend = 'WASAPI Shared';
  const requests = installBridge(({ command, args }) => {
    if (command === 'Reconfigure')
      backend = args?.backend === 'wasapi-exclusive' ? 'WASAPI Exclusive' : 'WASAPI Shared';
    return { status: 0, text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
      ? `SessionState: Running\nBackend: ${backend}\nRuntimeOutputSampleRate: 48000` : 'Ok' };
  }, { joinRoomVoice: vi.fn(async () => { throw new Error('Join failed'); }),
    leaveRoomVoice: vi.fn(async () => undefined) });
  const { audioClient } = await import('./audioClient');
  await expect(audioClient.joinVoiceSession('room', 'self')).rejects.toThrow('Join failed');
  expect(backend).toBe('WASAPI Shared');
  requests.length = 0;
  await Promise.all([audioClient.setMonitoring(true), audioClient.setMonitoring(false)]);
  expect(backend).toBe('WASAPI Shared');
  expect(requests.filter(r => r.command === 'Reconfigure').map(r => r.args?.backend))
    .toEqual(['wasapi-exclusive', 'wasapi-shared']);
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

it('restores personal participant gain after reconnect without recreating a nonexistent client slot', async () => {
  const joinRoomVoice = vi.fn(async () => undefined);
  const setRoomVoiceParticipantGain = vi.fn(async () => undefined);
  const requests = installBridge(undefined, {
    joinRoomVoice,
    setRoomVoiceParticipantGain,
  });
  const { audioClient } = await import('./audioClient');
  await audioClient.joinVoiceSession('room', 'self');
  await audioClient.setParticipantVolume('friend', 0.42);
  requests.length = 0;
  setRoomVoiceParticipantGain.mockClear();
  await audioClient.reconnectVoiceSession();
  expect(setRoomVoiceParticipantGain).toHaveBeenCalledWith('friend', 0.42);
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
  await audioClient.setParticipantVolume('host', 0);
  await audioClient.setParticipantMuted('host', true);
  await audioClient.leaveVoiceSession();
  setRoomVoiceParticipantGain.mockClear();

  await audioClient.joinVoiceSession('new-room', 'self');

  expect(setRoomVoiceParticipantGain).not.toHaveBeenCalledWith('host', 0);
  expect(audioClient.participantMuted('host')).toBe(false);
});

it('keeps the selected ASIO backend across a temporary WASAPI fallback and restores it on room join', async () => {
  let devicesAvailable = false;
  let backend = 'WASAPI Shared';
  let sessionState = 'Idle';
  const requests = installBridge(
    (request) => {
      if (
        request.command === 'PrepareSession' ||
        request.command === 'Reconfigure'
      ) {
        backend = request.args?.backend === 'asio' ? 'ASIO' : 'WASAPI Shared';
        sessionState = 'Prepared';
      }
      if (request.command === 'StartSession') sessionState = 'Running';
      return {
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
          request.command,
        )
          ? `SessionState: ${sessionState}\nBackend: ${backend}\nRuntimeOutputSampleRate: 48000`
          : request.command === 'GetDevices'
            ? devicesAvailable
              ? 'asio-driver,ASIO Driver,3,0,0\nasio-driver,ASIO Driver,3,1,0'
              : 'default-mic,Microphone,1,0,2\ndefault-output,Speakers,1,1,2'
            : 'Ok',
      };
    },
    {
      joinRoomVoice: vi.fn(async () => undefined),
    },
  );
  const { audioClient } = await import('./audioClient');
  audioClient.setPreferredConfiguration({
    backend: 'ASIO',
    inputDeviceId: 'asio-driver',
    outputDeviceId: 'asio-driver',
    sampleRate: 48_000,
    periodFrames: 0,
    bufferFrames: 128,
  });

  // The driver is briefly unavailable during ordinary startup, so audio continues on Shared.
  await audioClient.playTestSound();
  expect(requests).toContainEqual(
    expect.objectContaining({
      command: 'PrepareSession',
      args: expect.objectContaining({ backend: 'wasapi-shared' }),
    }),
  );

  devicesAvailable = true;
  requests.length = 0;
  await audioClient.joinVoiceSession('room', 'self');

  expect(requests).toContainEqual(
    expect.objectContaining({
      command: 'Reconfigure',
      args: expect.objectContaining({
        backend: 'asio',
        input: 'asio-driver',
        output: 'asio-driver',
        period: 128,
      }),
    }),
  );
});

it.each([
  {
    label: 'legacy',
    userSelectedAsio: false,
    backend: 'wasapi-shared',
    name: 'WASAPI Shared',
  },
  { label: 'explicit', userSelectedAsio: true, backend: 'asio', name: 'ASIO' },
] as const)(
  'uses the $name route for a $label ASIO4ALL profile across room join',
  async ({ userSelectedAsio, backend: expectedBackend, name }) => {
    let backend = 'WASAPI Shared';
    let sessionState = 'Idle';
    const requests = installBridge(
      (request) => {
        if (
          request.command === 'PrepareSession' ||
          request.command === 'Reconfigure'
        ) {
          backend = request.args?.backend === 'asio' ? 'ASIO' : 'WASAPI Shared';
          sessionState = 'Prepared';
        }
        if (request.command === 'StartSession') sessionState = 'Running';
        return {
          status: 0,
          text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
            request.command,
          )
            ? `SessionState: ${sessionState}\nBackend: ${backend}\nRuntimeOutputSampleRate: 48000`
            : request.command === 'GetDevices'
              ? 'asio4all,ASIO4ALL v2,3,0,0\nasio4all,ASIO4ALL v2,3,1,0\nmic,Microphone Array,1,0,2\nspeaker,Speakers,1,1,2'
              : 'Ok',
        };
      },
      {
        joinRoomVoice: vi.fn(async () => undefined),
      },
    );
    const { audioClient } = await import('./audioClient');
    audioClient.setPreferredConfiguration({
      backend: 'ASIO',
      inputDeviceId: 'asio4all',
      outputDeviceId: 'asio4all',
      sampleRate: 48_000,
      periodFrames: 0,
      bufferFrames: 512,
      userSelectedAsio,
    });

    await audioClient.playTestSound();
    await audioClient.joinVoiceSession('room', 'self');

    expect(
      requests
        .filter(
          ({ command }) =>
            command === 'PrepareSession' || command === 'Reconfigure',
        )
        .map(({ args }) => args?.backend),
    ).toEqual(userSelectedAsio ? [expectedBackend] : [expectedBackend, 'wasapi-exclusive']);
    expect(audioClient.preferredConfiguration().backend).toBe(name);
  },
);

it('routes an unnamed legacy ASIO4ALL selection to Windows defaults', async () => {
  const { safeAudioConfiguration, defaultAudioConfiguration } =
    await import('../shared/preferences/preferences');
  expect(
    safeAudioConfiguration(
      {
        backend: 'ASIO',
        sampleRate: 48_000,
        periodFrames: 0,
        bufferFrames: 512,
      },
      [{ id: 'asio4all', name: 'ASIO4ALL v2', backend: 'ASIO' }],
    ),
  ).toBe(defaultAudioConfiguration);
  expect(
    safeAudioConfiguration(
      {
        backend: 'ASIO',
        inputDeviceId: 'audient',
        outputDeviceId: 'audient',
        sampleRate: 48_000,
        periodFrames: 0,
      },
      [
        { id: 'asio4all', name: 'ASIO4ALL v2', backend: 'ASIO' },
        { id: 'audient', name: 'Audient ASIO', backend: 'ASIO' },
      ],
    ).backend,
  ).toBe('ASIO');
});

it('does not override a saved deliberate ASIO4ALL selection', async () => {
  const { safeAudioConfiguration } =
    await import('../shared/preferences/preferences');
  const selected = {
    backend: 'ASIO' as const,
    inputDeviceId: 'asio4all',
    outputDeviceId: 'asio4all',
    sampleRate: 48_000,
    periodFrames: 0,
    userSelectedAsio: true,
  };
  expect(
    safeAudioConfiguration(selected, [
      { id: 'asio4all', name: 'ASIO4ALL v2', backend: 'ASIO' },
    ]),
  ).toBe(selected);
});

it('keeps the working WASAPI fallback alive when preferred ASIO is still unavailable at join', async () => {
  let backend = 'WASAPI Shared';
  let sessionState = 'Idle';
  const joinRoomVoice = vi.fn(async () => {
    expect(sessionState).toBe('Running');
    expect(backend).toBe('WASAPI Shared');
  });
  const requests = installBridge(
    (request) => {
      if (request.command === 'PrepareSession') sessionState = 'Prepared';
      if (request.command === 'StartSession') sessionState = 'Running';
      if (
        request.command === 'Reconfigure' &&
        request.args?.backend === 'asio'
      ) {
        sessionState = 'Failed';
        return { status: 5, text: 'ASIO driver unavailable' };
      }
      if (request.command === 'Reconfigure') {
        backend =
          request.args?.backend === 'wasapi-exclusive'
            ? 'WASAPI Exclusive'
            : 'WASAPI Shared';
        sessionState = 'Prepared';
      }
      return {
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
          request.command,
        )
          ? `SessionState: ${sessionState}\nBackend: ${backend}\nRuntimeOutputSampleRate: 48000`
          : request.command === 'GetDevices'
            ? 'default-mic,Microphone,1,0,2\ndefault-output,Speakers,1,1,2'
            : 'Ok',
      };
    },
    {
      joinRoomVoice,
    },
  );
  const { audioClient } = await import('./audioClient');
  audioClient.setPreferredConfiguration({
    backend: 'ASIO',
    inputDeviceId: 'missing-asio',
    outputDeviceId: 'missing-asio',
    sampleRate: 48_000,
    periodFrames: 0,
    bufferFrames: 128,
  });
  await audioClient.playTestSound();
  requests.length = 0;

  await audioClient.joinVoiceSession('room', 'self');

  expect(joinRoomVoice).toHaveBeenCalledOnce();
  expect(
    requests
      .filter((request) => request.command === 'Reconfigure')
      .map((request) => request.args?.backend),
  ).toEqual([]);
  expect(audioClient.preferredConfiguration().backend).toBe('ASIO');
});

it('does not tear down an active ASIO session when its endpoint disappears before reconfigure', async () => {
  let sessionState = 'Running';
  const requests = installBridge((request) => {
    if (request.command === 'Reconfigure') {
      sessionState = 'Failed';
      return { status: 5, text: 'ASIO driver unavailable' };
    }
    return {
      status: 0,
      text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(request.command)
        ? `SessionState: ${sessionState}\nBackend: ASIO\nRuntimeOutputSampleRate: 48000`
        : request.command === 'GetDevices'
          ? 'default-mic,Microphone,1,0,2\ndefault-output,Speakers,1,1,2'
          : 'Ok',
    };
  });
  const { audioClient } = await import('./audioClient');
  const asio = {
    backend: 'ASIO' as const,
    inputDeviceId: 'asio-device',
    outputDeviceId: 'asio-device',
    sampleRate: 48_000,
    periodFrames: 0,
    bufferFrames: 128,
  };
  audioClient.setPreferredConfiguration(asio);

  await expect(audioClient.applyConfiguration(asio)).rejects.toThrow(
    'unavailable',
  );

  expect(
    requests.filter((request) => request.command === 'Reconfigure'),
  ).toEqual([]);
  expect((await audioClient.diagnosticsDump()).SessionState).toBe('Running');
  expect(audioClient.preferredConfiguration()).toEqual(asio);
});

it('accepts an enumerated ASIO driver whose channel count is not probed', async () => {
  const requests = installBridge((request) => {
    return {
      status: 0,
      text:
        request.command === 'GetDevices'
          ? 'audient,Audient USB Audio ASIO Driver,3,0,0\naudient,Audient USB Audio ASIO Driver,3,1,0'
          : ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(request.command)
            ? 'SessionState: Running\nBackend: ASIO\nRuntimeOutputSampleRate: 48000'
            : 'Ok',
    };
  });
  const { audioClient } = await import('./audioClient');
  await audioClient.applyConfiguration({
    backend: 'ASIO',
    inputDeviceId: 'audient',
    outputDeviceId: 'audient',
    sampleRate: 48_000,
    periodFrames: 0,
    bufferFrames: 256,
  });
  expect(requests).toContainEqual(
    expect.objectContaining({
      command: 'Reconfigure',
      args: expect.objectContaining({
        backend: 'asio',
        input: 'audient',
        output: 'audient',
        period: 256,
      }),
    }),
  );
});

it('keeps output running on Shared when an installed ASIO driver rejects startup', async () => {
  let sessionState = 'Idle';
  let backend = 'WASAPI Shared';
  const requests = installBridge((request) => {
    if (
      request.command === 'PrepareSession' &&
      request.args?.backend === 'asio'
    ) {
      sessionState = 'Failed';
      return { status: 5, text: 'ASIO createBuffers failed: code=-999' };
    }
    if (request.command === 'StopSession') sessionState = 'Idle';
    if (request.command === 'PrepareSession') {
      sessionState = 'Prepared';
      backend = 'WASAPI Shared';
    }
    if (request.command === 'StartSession') sessionState = 'Running';
    return {
      status: 0,
      text:
        request.command === 'GetDevices'
          ? 'audient,Audient USB Audio ASIO Driver,3,0,0\naudient,Audient USB Audio ASIO Driver,3,1,0'
          : ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(request.command)
            ? `SessionState: ${sessionState}\nBackend: ${backend}\nRuntimeOutputSampleRate: 44100`
            : 'Ok',
    };
  });
  const { audioClient } = await import('./audioClient');
  audioClient.setPreferredConfiguration({
    backend: 'ASIO',
    inputDeviceId: 'audient',
    outputDeviceId: 'audient',
    sampleRate: 0,
    periodFrames: 0,
    bufferFrames: 256,
  });
  await audioClient.playTestSound();
  expect(
    requests
      .filter((request) => request.command === 'PrepareSession')
      .map((request) => request.args?.backend),
  ).toEqual(['asio', 'wasapi-shared']);
  expect(requests).toContainEqual({
    command: 'PlayOutputTest',
    args: undefined,
  });
  expect(audioClient.preferredConfiguration().backend).toBe('ASIO');
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

it('preserves preferred, actual, room and final-PCM invariants through 1000 seeded lifecycle events', async () => {
  const backendNames = ['WASAPI Shared', 'WASAPI Exclusive', 'ASIO'] as const;
  const backendCode = (backend: (typeof backendNames)[number]) =>
    backend === 'ASIO'
      ? 'asio'
      : backend === 'WASAPI Exclusive'
        ? 'wasapi-exclusive'
        : 'wasapi-shared';
  const configuration = (
    backend: (typeof backendNames)[number],
    variant: number,
  ) => ({
    backend,
    inputDeviceId: `${backendCode(backend)}-device`,
    outputDeviceId: `${backendCode(backend)}-device`,
    sampleRate: [44_100, 48_000, 96_000][variant % 3]!,
    periodFrames: backend === 'WASAPI Shared' ? [480, 512][variant % 2]! : 0,
    bufferFrames:
      backend === 'WASAPI Shared' ? undefined : [64, 128, 256][variant % 3]!,
  });
  const nextRandom = (state: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (const seed of [0x51a0, 0xa510, 0xc0de, 0xbeef]) {
    vi.resetModules();
    let random = seed;
    let actual: (typeof backendNames)[number] = 'WASAPI Shared';
    let expectedPreferred: (typeof backendNames)[number] = actual;
    let sessionState = 'Running';
    let generation = 1;
    let networkGeneration = 0;
    let joined = false;
    let serverMixRegistered = false;
    const available = new Set<(typeof backendNames)[number]>(backendNames);
    installBridge(
      (request) => {
        if (request.command === 'Reconfigure') {
          const requested =
            request.args?.backend === 'asio'
              ? 'ASIO'
              : request.args?.backend === 'wasapi-exclusive'
                ? 'WASAPI Exclusive'
                : 'WASAPI Shared';
          if (!available.has(requested)) {
            sessionState = 'Failed';
            return { status: 5, text: `${requested} unavailable` };
          }
          actual = requested;
          sessionState = 'Prepared';
          generation += 1;
        }
        if (request.command === 'StartSession') sessionState = 'Running';
        if (request.command === 'AddRemoteParticipant')
          serverMixRegistered = true;
        return {
          status: 0,
          text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(
            request.command,
          )
            ? [
                `SessionState: ${sessionState}`,
                `Backend: ${actual}`,
                `generationId: ${generation}`,
                `NetworkGeneration: ${networkGeneration}`,
                `ActiveOutputDeviceId: ${backendCode(actual)}-device`,
                `RuntimeOutputSampleRate: ${actual === 'ASIO' ? 44_100 : 48_000}`,
                `RuntimeOutputPeriodFrames: ${actual === 'WASAPI Shared' ? 512 : 128}`,
                `RemoteDecodedPeak.__room_server_mix__: ${joined && serverMixRegistered ? 0.2 : 0}`,
                `RemoteQueuedPeak.__room_server_mix__: ${joined && serverMixRegistered ? 0.2 : 0}`,
                `RemoteRenderedPeak.__room_server_mix__: ${joined && serverMixRegistered ? 0.2 : 0}`,
                `MasterOutputPeak: ${joined && serverMixRegistered ? 0.2 : 0}`,
              ].join('\n')
            : request.command === 'GetDevices'
              ? backendNames
                  .filter((item) => available.has(item))
                  .flatMap((item) => [
                    `${backendCode(item)}-device,Input,${item === 'ASIO' ? 3 : item === 'WASAPI Exclusive' ? 2 : 1},0,2`,
                    `${backendCode(item)}-device,Output,${item === 'ASIO' ? 3 : item === 'WASAPI Exclusive' ? 2 : 1},1,2`,
                  ])
                  .join('\n')
              : 'Ok',
        };
      },
      {
        joinRoomVoice: vi.fn(async () => {
          joined = true;
          networkGeneration += 1;
          serverMixRegistered = false;
        }),
        leaveRoomVoice: vi.fn(async () => {
          joined = false;
          serverMixRegistered = false;
        }),
      },
    );
    const { audioClient } = await import('./audioClient');
    audioClient.setPreferredConfiguration(configuration(expectedPreferred, 0));
    const recentActions: string[] = [];

    for (let step = 0; step < 250; ++step) {
      random = nextRandom(random);
      const action = random % 8;
      if (action === 0) await audioClient.joinVoiceSession('room', 'self');
      else if (action === 1) await audioClient.reconnectVoiceSession();
      else if (action === 2) await audioClient.leaveVoiceSession();
      else if (action <= 5) {
        const target = backendNames[(random >>> 8) % backendNames.length]!;
        const next = configuration(target, random >>> 16);
        recentActions.push(
          `${step}:configure:${target}:available=${available.has(target)}`,
        );
        try {
          await audioClient.applyConfiguration(next);
          expectedPreferred = target;
        } catch {
          /* unavailable devices must roll back without corrupting the room */
        }
      } else if (action === 6) {
        recentActions.push(`${step}:remove:ASIO`);
        available.delete('ASIO');
      } else {
        recentActions.push(`${step}:add:ASIO`);
        available.add('ASIO');
      }
      if (action <= 2)
        recentActions.push(`${step}:${['join', 'reconnect', 'leave'][action]}`);
      if (recentActions.length > 12) recentActions.shift();

      const diagnostics = await audioClient.diagnosticsDump();
      const context = `seed=${seed.toString(16)} step=${step} action=${action} actual=${actual} preferred=${expectedPreferred} available=${[...available].join(',')} recent=${recentActions.join('|')}`;
      expect(audioClient.preferredConfiguration().backend, context).toBe(
        expectedPreferred,
      );
      expect(backendNames).toContain(diagnostics.Backend);
      expect(diagnostics.SessionState, context).toBe('Running');
      if (joined) {
        expect(serverMixRegistered, context).toBe(true);
        expect(
          Number(diagnostics['RemoteDecodedPeak.__room_server_mix__']),
          context,
        ).toBeGreaterThan(0);
        expect(Number(diagnostics.MasterOutputPeak), context).toBeGreaterThan(
          0,
        );
      }
    }
    await audioClient.leaveVoiceSession();
  }
}, 30_000);
