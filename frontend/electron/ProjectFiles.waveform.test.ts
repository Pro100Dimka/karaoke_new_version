import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ipcChannels } from './ipcChannels';
import { registerProjectFileHandlers } from './ProjectFiles';

vi.mock('electron', () => ({ shell: {} }));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'song-waveform-'));
  roots.push(root);
  const request = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: [0, 0.7, 1],
  });
  const peaks = vi.fn().mockResolvedValue([0.2, 1, 0.4]);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerProjectFileHandlers(
    () => root,
    { request } as never,
    {
      handle: (channel, listener) =>
        handlers.set(channel, listener as (...args: unknown[]) => unknown),
    },
    peaks,
  );
  return {
    root,
    request,
    peaks,
    invoke: (revision = 0, songId = 'imported') =>
      Promise.resolve().then(() => {
        const handler = handlers.get(ipcChannels.waveformPeaks);
        if (!handler) throw new Error('Missing waveform handler');
        return handler({}, { songId, revision, bins: 480 });
      }),
  };
};

describe('song waveform IPC', () => {
  it('reads the source waveform for the first processing attempt at revision zero', async () => {
    const { invoke, request, peaks } = await setup();
    await expect(invoke()).resolves.toEqual([0, 0.7, 1]);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      '/songs/imported/waveform?bins=480',
    );
    expect(peaks).not.toHaveBeenCalled();
  });

  it('keeps the source fallback when a positive revision has no manifest yet', async () => {
    const { invoke, request, peaks } = await setup();
    await expect(invoke(1)).resolves.toEqual([0, 0.7, 1]);
    expect(request).toHaveBeenCalledOnce();
    expect(peaks).not.toHaveBeenCalled();
  });

  it('uses published instrumental peaks before the source fallback', async () => {
    const { root, invoke, request, peaks } = await setup();
    const revisionRoot = path.join(root, 'songs', 'imported', 'revisions', '2');
    await mkdir(revisionRoot, { recursive: true });
    await writeFile(
      path.join(revisionRoot, 'manifest.json'),
      JSON.stringify({
        artifacts: [{ logicalName: 'instrumental', relativePath: 'minus.mp3' }],
      }),
    );
    await expect(invoke(2)).resolves.toEqual([0.2, 1, 0.4]);
    expect(peaks).toHaveBeenCalledExactlyOnceWith(
      path.join(revisionRoot, 'minus.mp3'),
      480,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, status: 404, body: [] },
    { ok: true, status: 200, body: { message: 'unavailable' } },
    { ok: true, status: 200, body: [0, Number.NaN] },
  ])('rejects an unavailable source response %#', async (response) => {
    const { invoke, request } = await setup();
    request.mockResolvedValueOnce(response);
    await expect(invoke()).rejects.toThrow('Song waveform is unavailable');
  });

  it.each([
    [-1, 'imported'],
    [0.5, 'imported'],
    [Number.MAX_SAFE_INTEGER + 1, 'imported'],
    [0, '../outside'],
    [1, '../outside'],
  ] as const)(
    'rejects invalid project identity %j, %s before reading',
    async (revision, songId) => {
      const { invoke, request, peaks } = await setup();
      await expect(invoke(revision, songId)).rejects.toThrow(
        'Invalid project identity',
      );
      expect(request).not.toHaveBeenCalled();
      expect(peaks).not.toHaveBeenCalled();
    },
  );
});
