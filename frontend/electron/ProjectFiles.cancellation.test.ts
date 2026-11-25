import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerProjectFileHandlers } from './ProjectFiles';
import { ipcChannels } from './ipcChannels';

vi.mock('electron', () => ({ shell: {} }));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const owner = () =>
  Object.assign(new EventEmitter(), { isDestroyed: () => false });
const setup = (root = path.resolve('waveform-test-project')) => {
  const responses: Array<{
    signal?: AbortSignal;
    resolve(value: unknown): void;
  }> = [];
  const request = vi.fn(
    (_path: string, init?: RequestInit) =>
      new Promise((resolve) => {
        responses.push({ signal: init?.signal ?? undefined, resolve });
        init?.signal?.addEventListener(
          'abort',
          () => resolve({ ok: false, status: 499, body: null }),
          { once: true },
        );
      }),
  );
  const peaks = vi.fn(
    async (_file: string, _bins: number, _signal?: AbortSignal) => [1],
  );
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
  const invoke = (
    channel: string,
    sender: ReturnType<typeof owner>,
    value: unknown,
  ) =>
    Promise.resolve().then(() => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing handler: ${channel}`);
      return handler({ sender }, value);
    });
  return {
    request,
    peaks,
    responses,
    invoke,
    finish: () =>
      responses.forEach(({ resolve }) =>
        resolve({ ok: true, status: 200, body: [1] }),
      ),
    read: (sender: ReturnType<typeof owner>, requestId: string, revision = 0) =>
      invoke(ipcChannels.waveformPeaks, sender, {
        songId: 'song',
        revision,
        bins: 480,
        requestId,
      }).catch((error: unknown) => error),
  };
};

it('aborts only the named waveform owned by the cancelling renderer', async () => {
  const view = setup();
  const a = owner();
  const b = owner();
  const reads = [
    view.read(a, 'shared-id'),
    view.read(a, 'sibling'),
    view.read(b, 'shared-id'),
  ];
  try {
    await vi.waitFor(() => expect(view.responses).toHaveLength(3));
    await view.invoke(ipcChannels.cancelWaveform, a, 'shared-id');
    expect(view.responses.map(({ signal }) => signal?.aborted)).toEqual([
      true,
      false,
      false,
    ]);
    expect(await reads[0]).toMatchObject({ name: 'AbortError' });
  } finally {
    view.finish();
    await Promise.all(reads);
  }
});

it.each(['destroyed', 'render-process-gone', 'did-start-navigation'] as const)(
  'releases requests owned by a renderer on %s',
  async (reason) => {
    const view = setup();
    const a = owner();
    const b = owner();
    const reads = [
      view.read(a, 'one'),
      view.read(a, 'two'),
      view.read(b, 'one'),
    ];
    try {
      await vi.waitFor(() => expect(view.responses).toHaveLength(3));
      a.emit(reason, { isMainFrame: true, isSameDocument: false });
      expect(view.responses.map(({ signal }) => signal?.aborted)).toEqual([
        true,
        true,
        false,
      ]);
    } finally {
      view.finish();
      await Promise.all(reads);
    }
  },
);

it('does not start a backend fallback after local waveform cancellation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'project-waveform-cancel-'));
  roots.push(root);
  const revision = path.join(root, 'songs', 'song', 'revisions', '1');
  await mkdir(revision, { recursive: true });
  await writeFile(
    path.join(revision, 'manifest.json'),
    JSON.stringify({
      artifacts: [
        { logicalName: 'instrumental', relativePath: 'instrumental.wav' },
      ],
    }),
  );
  const view = setup(root);
  const a = owner();
  await expect(
    view.invoke(ipcChannels.resolveProjectArtifacts, a, {
      songId: 'song',
      revision: 1,
    }),
  ).resolves.toHaveProperty('instrumental');
  let fail!: (error: Error) => void;
  view.peaks.mockImplementationOnce(
    (_file, _bins, signal) =>
      new Promise((_resolve, reject) => {
        fail = reject;
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const result = view.read(a, 'local-read', 1);
  try {
    await vi.waitFor(() => expect(view.peaks).toHaveBeenCalledOnce());
    await view.invoke(ipcChannels.cancelWaveform, a, 'local-read');
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(view.request).not.toHaveBeenCalled();
  } finally {
    fail?.(new Error('test cleanup'));
    view.finish();
  }
});
