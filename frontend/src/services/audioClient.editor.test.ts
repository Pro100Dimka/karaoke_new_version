import { afterEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../contracts/models';
import { audioClient } from './audioClient';
import { installBridge } from './audioClientFixture';
import { audioState } from './audioSession';

afterEach(() => {
  Reflect.deleteProperty(window, 'desktop');
  audioState.reconfiguration.song = null;
  audioState.reconfiguration.playbackRate = 1;
  audioState.reconfiguration.pitchShift = 0;
  vi.restoreAllMocks();
});

it.each([4, 3])(
  'refreshes an edited guide without losing transport state %i',
  async (state) => {
    let playback = 2;
    let frame = 0;
    const resolveProjectArtifacts = vi.fn(
      async (_song: string, revision: number) => ({
        instrumental: `backing-${revision}`,
        vocals: `voice-${revision}`,
        melody: `guide-${revision}`,
      }),
    );
    const { requests } = installBridge(
      ({ command, args }) => {
        if (command === 'LoadSong') {
          playback = 2;
          frame = 0;
        }
        if (command === 'Seek') frame = Number(args?.frame);
        if (command === 'Play') playback = 3;
        return {
          status: 0,
          text: `SessionState: Running\nPlaybackState: ${playback}\nRuntimeOutputSampleRate: 48000\nPlaybackPositionFrames: ${frame}`,
        };
      },
      { resolveProjectArtifacts },
    );
    const song = {
      id: 'song',
      activeRevision: 1,
      durationSeconds: 120,
    } as SongDto;
    await audioClient.prepareSong(song);
    await audioClient.setPlaybackRate(0.75);
    await audioClient.setPitchShift(-5);
    playback = state;
    frame = 27.25 * 48000;
    requests.length = 0;

    const result = await audioClient.prepareSong(
      { ...song, activeRevision: 2 },
      () => true,
      { preservePlayback: true },
    );

    expect(resolveProjectArtifacts).toHaveBeenLastCalledWith('song', 2);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'LoadSong',
          args: {
            instrumental: 'backing-2',
            vocals: 'voice-2',
            melody: 'guide-2',
          },
        }),
        expect.objectContaining({
          command: 'SetPlaybackRate',
          args: { value: 0.75 },
        }),
        expect.objectContaining({
          command: 'SetTranspose',
          args: { semitones: -5 },
        }),
        expect.objectContaining({
          command: 'Seek',
          args: { frame: 27.25 * 48000 },
        }),
      ]),
    );
    expect(requests.filter(({ command }) => command === 'Play')).toHaveLength(
      state === 3 ? 1 : 0,
    );
    expect(result.positionSeconds).toBe(27.25);
    expect(result.state).toBe(state === 3 ? 'playing' : 'paused');
  },
);

it('does not resume an editor refresh after navigation cancels it', async () => {
  let current = true;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const restoring = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { commands } = installBridge(
    async ({ command }) => {
      if (command === 'SetTranspose') {
        started();
        await held;
      }
      return {
        status: 0,
        text: 'SessionState: Running\nPlaybackState: 3\nRuntimeOutputSampleRate: 48000\nPlaybackPositionFrames: 480000',
      };
    },
    {
      resolveProjectArtifacts: vi.fn(async (id) => ({ instrumental: id })),
    },
  );
  const song = { id: 'old', activeRevision: 1 } as SongDto;
  audioState.reconfiguration.song = song;
  const refreshing = audioClient
    .prepareSong({ ...song, activeRevision: 2 }, () => current, {
      preservePlayback: true,
    })
    .catch((error: Error) => error);
  await restoring;
  current = false;
  const replacement = audioClient.prepareSong({ ...song, id: 'next' });
  release();
  expect(await refreshing).toMatchObject({ name: 'AbortError' });
  await replacement;
  expect(commands).not.toContain('Play');
  expect(audioState.reconfiguration.song?.id).toBe('next');
});
