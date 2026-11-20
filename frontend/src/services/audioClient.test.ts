import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBridge } from './audioClientFixture';
import { audioClient, getAudioSnapshot } from './audioClient';
import { waitForReady } from './audioSession';
describe('audioClient contract', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktop');
    vi.restoreAllMocks();
  });

  it('finishes obsolete native loading before preparing the replacement song', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = true;
    const { requests } = installBridge(
      async ({ command, args }) => {
        if (command === 'LoadSong' && args?.instrumental === 'old') await held;
        return { status: 0, text: 'SessionState: Running\nPlaybackState: 2' };
      },
      {
        resolveProjectArtifacts: vi.fn(async (id) => ({
          instrumental: id,
          vocals: '',
          melody: '',
        })),
      },
    );
    const song = {
      id: 'old',
      activeRevision: 1,
    } as import('../contracts/models').SongDto;
    const old = audioClient
      .prepareSong(song, () => current)
      .catch((error) => error);
    await vi.waitFor(() =>
      expect(requests.some((request) => request.command === 'LoadSong')).toBe(
        true,
      ),
    );
    current = false;
    const next = audioClient.prepareSong({ ...song, id: 'new' });
    release();
    await Promise.all([old, next]);
    expect(
      requests
        .filter((request) =>
          ['LoadSong', 'UnloadSong'].includes(request.command),
        )
        .map((request) => [request.command, request.args?.instrumental]),
    ).toEqual([
      ['LoadSong', 'old'],
      ['UnloadSong', undefined],
      ['LoadSong', 'new'],
    ]);
  });

  it('does not load an obsolete song after resolving its artifacts', async () => {
    let finish!: (value: {
      instrumental: string;
      vocals: string;
      melody: string;
    }) => void;
    let current = true;
    const resolveProjectArtifacts = vi.fn(
      () =>
        new Promise<{ instrumental: string; vocals: string; melody: string }>(
          (resolve) => {
            finish = resolve;
          },
        ),
    );
    const { commands } = installBridge(
      () => ({ status: 0, text: 'SessionState: Running\nPlaybackState: 2' }),
      { resolveProjectArtifacts },
    );
    const song = {
      id: 'obsolete',
      activeRevision: 1,
    } as import('../contracts/models').SongDto;
    const preparing = audioClient.prepareSong(song, () => current);
    const settled = preparing.catch((error) => error);
    await vi.waitFor(() =>
      expect(resolveProjectArtifacts).toHaveBeenCalledOnce(),
    );
    current = false;
    finish({ instrumental: 'old.wav', vocals: '', melody: '' });
    await settled;
    expect(commands).not.toContain('LoadSong');
  });

  it('serializes health observations with a complete device transition', async () => {
    const { audioState } = await import('./audioSession');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { requests } = installBridge(async ({ command }) => {
      if (command === 'GetServiceState') {
        entered();
        await held;
      }
      return {
        status: 0,
        text:
          command === 'GetServiceState'
            ? 'Running'
            : 'SessionState: Running\nRuntimeOutputSampleRate: 48000',
      };
    });
    audioState.reconfiguration.song = null;
    const health = audioClient.health();
    await started;
    const changed = audioClient.applyConfiguration({
      backend: 'WASAPI Shared',
      sampleRate: 48000,
      periodFrames: 0,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests.some((r) => r.command === 'Reconfigure')).toBe(false);
    } finally {
      release();
      await Promise.allSettled([health, changed]);
    }
  });

  it('distinguishes a controlled mode switch from an unexpected native session replacement', async () => {
    const { audioState } = await import('./audioSession');
    let generation = 1;
    installBridge(({ command }) => {
      if (command === 'Reconfigure') generation++;
      return {
        status: 0,
        text:
          command === 'GetServiceState'
            ? 'Running'
            : `SessionState: Running\nServiceInstanceId: controlled-test\ngenerationId: ${generation}\nRuntimeOutputSampleRate: 48000`,
      };
    });
    audioState.reconfiguration.song = null;
    const before = await audioClient.health();
    await audioClient.applyConfiguration({
      backend: 'WASAPI Shared',
      sampleRate: 48000,
      periodFrames: 0,
    });
    expect((await audioClient.health()).instanceId).toBe(before.instanceId);
    generation++;
    expect((await audioClient.health()).instanceId).not.toBe(before.instanceId);
  });

  it('detects lost prepared media even when a restarted process answers successfully', async () => {
    const { audioState } = await import('./audioSession');
    const previous = audioState.reconfiguration.song;
    audioState.reconfiguration.song = {
      id: 'song',
      title: 'Song',
      artist: 'Artist',
      language: 'Auto',
      status: 'ready',
      durationSeconds: 120,
      createdAt: '2026-11-03',
      coverState: 'Fallback',
      activeRevision: 1,
      projectFormatVersion: 1,
    };
    installBridge(async (request) => {
      if (request.command === 'UnloadSong')
        await expect(getAudioSnapshot()).resolves.toMatchObject({
          state: 'ready',
        });
      return {
        status: 0,
        text: 'PlaybackState: 0\nRuntimeOutputSampleRate: 44100',
      };
    });
    try {
      await expect(getAudioSnapshot()).rejects.toThrow('prepared song');
      await expect(audioClient.stop()).resolves.toMatchObject({
        state: 'finished',
      });
    } finally {
      audioState.reconfiguration.song = previous;
    }
  });

  it.each([
    { readyAfter: 3000, failed: false, expected: 'ready' },
    {
      readyAfter: Infinity,
      failed: true,
      expected: 'AudioService failed to load the song',
    },
    {
      readyAfter: Infinity,
      failed: false,
      expected: 'AudioService song loading timed out',
    },
  ])(
    'waits for a slow real load and still bounds failed/stuck loads: $expected',
    async ({ readyAfter, failed, expected }) => {
      vi.useFakeTimers();
      try {
        const started = performance.now();
        installBridge(() => ({
          status: 0,
          text: `PlaybackState: ${failed ? 7 : performance.now() - started >= readyAfter ? 2 : 1}`,
        }));
        const result = waitForReady().then(
          () => 'ready',
          (error: Error) => error.message,
        );
        await vi.advanceTimersByTimeAsync(15_100);
        expect(await result).toBe(expected);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { readyAfter: 30_000, progressUntil: 30_000, expected: 'ready' },
    {
      readyAfter: Infinity,
      progressUntil: 5_000,
      expected: 'AudioService song loading timed out',
    },
  ])(
    'waits for actual loading progress and still bounds a stalled decoder: $expected',
    async ({ readyAfter, progressUntil, expected }) => {
      vi.useFakeTimers();
      try {
        const started = performance.now();
        installBridge(() => {
          const elapsed = performance.now() - started;
          return {
            status: 0,
            text: `PlaybackState: ${elapsed >= readyAfter ? 2 : 1}\nPlaybackLoadProgressFrames: ${Math.floor(Math.min(elapsed, progressUntil) / 1000) * 48000}`,
          };
        });
        let finishedAt = 0;
        const result = waitForReady()
          .then(
            () => 'ready',
            (error: Error) => error.message,
          )
          .finally(() => {
            finishedAt = performance.now() - started;
          });
        await vi.advanceTimersByTimeAsync(31_000);
        expect(await result).toBe(expected);
        expect(finishedAt).toBe(
          readyAfter === Infinity ? progressUntil + 15_000 : readyAfter,
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('rejects failed runtime diagnostics instead of displaying a healthy device', async () => {
    installBridge(() => ({
      status: 0,
      text: 'SessionState: Failed\nLastFailureMessage: DeviceLost\nRuntimeOutputSampleRate: 0',
    }));
    await expect(audioClient.runtimeConfiguration()).rejects.toThrow(
      'DeviceLost',
    );
  });

  it("closes the song's files when playback stops, so the song can be deleted afterwards", async () => {
    const { commands } = installBridge(() => ({ status: 0, text: 'Ok' }));
    await audioClient.stop();
    expect(commands.slice(0, 2)).toEqual(['Stop', 'UnloadSong']);
  });

  it('uses the monitoring path and the actual output clock for its estimate', async () => {
    installBridge(() => ({
      status: 0,
      text: [
        'RuntimeOutputSampleRate: 44100',
        'RequestedSampleRate: 48000',
        'MonitoringLatencyFrames: 1764',
        'EstimatedLatencyFrames: 4410',
      ].join('\n'),
    }));
    await expect(audioClient.runtimeConfiguration()).resolves.toMatchObject({
      estimatedLatencyMs: 40,
    });
  });

  it('reports ready when AudioService answers Running', async () => {
    installBridge(() => ({ status: 0, text: 'Running' }));
    expect(await audioClient.health()).toMatchObject({ status: 'ready' });
  });

  it.each(['Idle', 'Failed'])(
    'restores an idle or failed session before reporting audio ready (%s)',
    async (initial) => {
      let session = initial;
      const { commands } = installBridge(({ command }) => {
        if (command === 'GetServiceState')
          return { status: 0, text: 'Running' };
        if (command === 'StartSession') session = 'Running';
        return {
          status: 0,
          text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
            ? `ServiceState: Running\nSessionState: ${session}\nServiceInstanceId: native-second\nBackend: WASAPI Shared`
            : 'Ok',
        };
      });
      await expect(audioClient.health()).resolves.toMatchObject({
        status: 'ready',
        instanceId: 'native-second',
      });
      expect(commands).toContain('PrepareSession');
      expect(commands).toContain('StartSession');
    },
  );

  it('does not report a live process as ready when its failed device cannot reopen', async () => {
    installBridge(({ command }) => {
      if (command === 'GetServiceState') return { status: 0, text: 'Running' };
      if (command === 'PrepareSession')
        return { status: -1, text: 'Device unavailable' };
      return {
        status: 0,
        text: 'ServiceState: Running\nSessionState: Failed\nBackend: WASAPI Shared',
      };
    });
    await expect(audioClient.health()).resolves.toMatchObject({
      status: 'unavailable',
    });
  });

  it('invalidates loaded media when the native device session recovers inside the same process', async () => {
    let generation = 1;
    installBridge(({ command }) => ({
      status: 0,
      text:
        command === 'GetServiceState'
          ? 'Running'
          : `SessionState: Running\nServiceInstanceId: same-process\ngenerationId: ${generation}`,
    }));
    const first = await audioClient.health();
    generation = 2;
    const recovered = await audioClient.health();
    expect(recovered.status).toBe('ready');
    expect(recovered.instanceId).not.toBe(first.instanceId);
    expect((await audioClient.health()).instanceId).toBe(recovered.instanceId);
  });

  it('keeps an intentionally suspended ASIO session suspended during health probes', async () => {
    const { commands } = installBridge(({ command }) => ({
      status: 0,
      text:
        command === 'GetServiceState'
          ? 'Running'
          : 'ServiceState: Running\nSessionState: Suspended\nServiceInstanceId: suspended',
    }));
    await expect(audioClient.health()).resolves.toMatchObject({
      status: 'ready',
      instanceId: 'suspended',
    });
    expect(commands).not.toContain('PrepareSession');
    expect(commands).not.toContain('StartSession');
  });

  it('reports unavailable when the transport returns a failure status', async () => {
    installBridge(() => ({
      status: -1,
      text: 'AudioService unavailable: ENOENT',
    }));
    expect(await audioClient.health()).toMatchObject({ status: 'unavailable' });
  });

  it('uses the AudioService suspend lifecycle while ASIO is released in the background', async () => {
    const { commands } = installBridge(() => ({ status: 0, text: 'Ok' }));
    await audioClient.suspendSession();
    await audioClient.resumeSession();
    expect(commands).toEqual([
      'SuspendSession',
      'GetDiagnostics',
      'ResumeSession',
      'GetDiagnostics',
    ]);
  });

  it('issues Pause and reads a paused snapshot', async () => {
    const { commands } = installBridge(({ command }) => ({
      status: 0,
      text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
        ? 'PlaybackState: 4\nPlaybackPositionFrames: 48000\nRuntimeOutputSampleRate: 48000'
        : 'Ok',
    }));
    const snapshot = await audioClient.pause();
    expect(commands).toEqual(['Pause', 'GetPlaybackSnapshot']);
    expect(snapshot).toMatchObject({ state: 'paused', positionSeconds: 1 });
  });

  it('passes the 250 ms conversation deadline to AudioService', async () => {
    const { requests: commands } = installBridge(() => ({
      status: 0,
      text: 'Ok',
    }));

    await audioClient.setRoomPlayoutDelay(250);

    expect(
      commands
        .filter((item) => item.command === 'SetRoomPlayoutDelay')
        .map((item) => item.args?.milliseconds),
    ).toEqual([250]);
  });

  it("does not publish the muted backup server's route stages during direct singing", async () => {
    installBridge(({ command }) => ({
      status: 0,
      text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
        ? [
            'RuntimeOutputSampleRate: 48000',
            'RoomRequestedDelayFrames: 480',
            'RemoteMuted.__room_server_mix__: 1',
            'RoomReturnRequirementFrames: 2400',
            'RoomArrivalRequirementFrames: 2400',
            'OutputDriverLatencyFrames: 240',
          ].join('\n')
        : 'Ok',
    }));
    const report = await audioClient.roomTiming();
    expect(report.requestedVoiceDelayMs).toBe(15);
    expect(report.returnRequirementMs).toBeUndefined();
    expect(report.arrivalRequirementMs).toBeUndefined();
  });

  it.each(['BOOTSTRAP', 'SHORT_WINDOW', 'STABLE_HISTORY'])(
    'preserves the native measured direct requirement source %s',
    async (requirementSource) => {
      installBridge(({ command }) => ({
        status: 0,
        text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
          ? [
              'RuntimeOutputSampleRate: 48000',
              'RoomVoiceRoute: direct',
              `RoomRequirementSource: ${requirementSource}`,
              'RoomRequestedDelayFrames: 1920',
              'OutputDriverLatencyFrames: 240',
              'RuntimeOutputPeriodFrames: 240',
            ].join('\n')
          : 'Ok',
      }));
      await expect(audioClient.roomTiming()).resolves.toMatchObject({
        requirementSource,
        requestedVoiceDelayMs: 50,
      });
    },
  );

  it('keeps an unknown direct requirement at zero despite a nonzero output lead', async () => {
    installBridge(({ command }) => ({
      status: 0,
      text: ['GetDiagnostics', 'GetPlaybackSnapshot'].includes(command)
        ? [
            'RuntimeOutputSampleRate: 48000',
            'RoomVoiceRoute: direct',
            'RoomRequirementSource: UNKNOWN',
            'RoomRequestedDelayFrames: 0',
            'OutputDriverLatencyFrames: 240',
            'RuntimeOutputLatencyFrames: 480',
            'RuntimeOutputPeriodFrames: 240',
          ].join('\n')
        : 'Ok',
    }));
    await expect(audioClient.roomTiming()).resolves.toMatchObject({
      requirementSource: 'UNKNOWN',
      requestedVoiceDelayMs: 0,
    });
  });
});
