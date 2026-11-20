import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioClient } from './audioClient';
import { installBridge } from './audioClientFixture';
import { audioState, waitForAudioOperations } from './audioSession';
import type { SongDto } from '../contracts/models';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const seekFixture = (failedAt?: number) => {
  const entered = deferred();
  const release = deferred();
  let frame = 0;
  const bridge = installBridge(
    async (request) => {
      if (request.command === 'Seek') {
        const next = Number(request.args?.frame);
        if (next === 48000) {
          entered.resolve();
          await release.promise;
        }
        if (next === failedAt) return { status: 7, text: 'Native seek failed' };
        frame = next;
      }
      return {
        status: 0,
        text: `SessionState: Running\nPlaybackState: 2\nPlaybackPositionFrames: ${frame}\nRuntimeOutputSampleRate: 48000`,
      };
    },
    {
      resolveProjectArtifacts: vi.fn(async () => ({
        instrumental: 'instrumental.wav',
        vocals: '',
        melody: '',
      })),
    },
  );
  return { ...bridge, entered, release };
};

beforeEach(() => {
  audioState.reconfiguration.song = null;
  audioState.reconfiguration.schedule = undefined;
});

afterEach(async () => {
  await waitForAudioOperations();
  Reflect.deleteProperty(window, 'desktop');
  vi.restoreAllMocks();
});

it('keeps a scrub burst to the in-flight seek and the latest pending position', async () => {
  const { entered, release, requests } = seekFixture();
  const first = audioClient.seek(1);
  await entered.promise;
  const pending = Array.from({ length: 120 }, (_, i) =>
    audioClient.seek(i + 2),
  );
  release.resolve();
  const [initial, ...results] = await Promise.all([first, ...pending]);

  expect(initial?.positionSeconds).toBe(1);
  expect(results.every((result) => result.positionSeconds === 121)).toBe(true);
  expect(
    requests
      .filter(({ command }) => command === 'Seek')
      .map(({ args }) => args?.frame),
  ).toEqual([48000, 121 * 48000]);
  expect(
    requests.filter(({ command }) => command === 'GetDiagnostics'),
  ).toHaveLength(2);
  expect(
    requests.filter(({ command }) => command === 'GetPlaybackSnapshot'),
  ).toHaveLength(2);
});

it.each(['pause', 'play', 'stop', 'load'] as const)(
  'retains a %s barrier between adjacent pending scrub groups',
  async (barrier) => {
    const { entered, release, requests } = seekFixture();
    const first = audioClient.seek(1);
    await entered.promise;
    const before = [audioClient.seek(2), audioClient.seek(3)];
    const transition =
      barrier === 'load'
        ? audioClient.prepareSong({
            id: 'replacement',
            activeRevision: 1,
            durationSeconds: 120,
          } as SongDto)
        : audioClient[barrier]();
    const after = [audioClient.seek(4), audioClient.seek(5)];
    release.resolve();
    await Promise.all([first, ...before, transition, ...after]);

    const transitions = requests
      .filter(({ command }) =>
        ['Seek', 'Pause', 'Play', 'Stop', 'UnloadSong', 'LoadSong'].includes(
          command,
        ),
      )
      .map(({ command, args }) =>
        command === 'Seek' ? `Seek:${Number(args?.frame) / 48000}` : command,
      );
    expect(transitions).toEqual([
      'Seek:1',
      'Seek:3',
      ...(barrier === 'load'
        ? ['LoadSong']
        : barrier === 'stop'
          ? ['Stop', 'UnloadSong']
          : [barrier === 'pause' ? 'Pause' : 'Play']),
      'Seek:5',
    ]);
  },
);

it('keeps independently owned seeks separate and cancels obsolete pending owners', async () => {
  const { entered, release, requests } = seekFixture();
  const first = audioClient.seek(1);
  await entered.promise;
  let current = true;
  const owner = () => current;
  const cancelled = [audioClient.seek(2, owner), audioClient.seek(3, owner)];
  const independent = [
    audioClient.seek(4, () => true),
    audioClient.seek(5, () => true),
  ];
  const settled = Promise.allSettled([...cancelled, ...independent]);
  current = false;
  release.resolve();
  await first;
  const results = await settled;

  expect(results.slice(0, 2)).toEqual([
    {
      status: 'rejected',
      reason: expect.objectContaining({ name: 'AbortError' }),
    },
    {
      status: 'rejected',
      reason: expect.objectContaining({ name: 'AbortError' }),
    },
  ]);
  expect(
    results
      .slice(2)
      .map((result) =>
        result.status === 'fulfilled' ? result.value.positionSeconds : null,
      ),
  ).toEqual([4, 5]);
  expect(
    requests
      .filter(({ command }) => command === 'Seek')
      .map(({ args }) => args?.frame),
  ).toEqual([48000, 4 * 48000, 5 * 48000]);
});

it('rejects every waiter of a failed merged seek and continues after a barrier', async () => {
  const { entered, release, requests } = seekFixture(3 * 48000);
  const first = audioClient.seek(1);
  await entered.promise;
  const failed = Promise.allSettled([audioClient.seek(2), audioClient.seek(3)]);
  const paused = audioClient.pause();
  const recovered = audioClient.seek(4);
  release.resolve();
  await Promise.all([first, paused]);

  expect(await failed).toEqual([
    {
      status: 'rejected',
      reason: expect.objectContaining({ message: 'Native seek failed' }),
    },
    {
      status: 'rejected',
      reason: expect.objectContaining({ message: 'Native seek failed' }),
    },
  ]);
  expect((await recovered).positionSeconds).toBe(4);
  expect(
    requests
      .filter(({ command }) => command === 'Seek')
      .map(({ args }) => args?.frame),
  ).toEqual([48000, 3 * 48000, 4 * 48000]);
});

it('does not return a stale position after its owner expires during the snapshot read', async () => {
  const entered = deferred();
  const release = deferred();
  let current = true;
  installBridge(async ({ command }) => {
    if (command === 'GetPlaybackSnapshot') {
      entered.resolve();
      await release.promise;
    }
    return {
      status: 0,
      text: 'SessionState: Running\nPlaybackState: 2\nPlaybackPositionFrames: 336000\nRuntimeOutputSampleRate: 48000',
    };
  });
  const result = audioClient.seek(7, () => current);
  const settled = Promise.allSettled([result]);
  await entered.promise;
  current = false;
  release.resolve();

  expect(await settled).toEqual([
    {
      status: 'rejected',
      reason: expect.objectContaining({ name: 'AbortError' }),
    },
  ]);
});
