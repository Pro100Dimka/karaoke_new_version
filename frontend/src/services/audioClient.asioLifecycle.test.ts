import { expect, it, vi } from 'vitest';
import { installBridge } from './audioVoiceFixture';

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
    ).toEqual(
      userSelectedAsio
        ? [expectedBackend]
        : [expectedBackend, 'wasapi-exclusive'],
    );
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
