import { expect, it, vi } from 'vitest';
import { installBridge } from './audioVoiceFixture';

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
