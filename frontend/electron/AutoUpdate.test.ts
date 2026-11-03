import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdtemp,
  readFile,
  rm,
  readdir,
  writeFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '1.1.1' },
}));
const { fetchInstaller } = await import('./AutoUpdate');

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const payload = Buffer.from(
  Array.from({ length: 300_000 }, (_, index) => index % 251),
);
const release = (
  sha256 = createHash('sha256').update(payload).digest('hex'),
) => ({
  version: '1.2.0',
  url: 'https://github.com/x/releases/download/v1.2.0/AD-Voice-Setup.exe',
  size: payload.length,
  sha256,
});
const serve = () => vi.fn(async () => new Response(new Uint8Array(payload)));

it('resumes a real HTTP transfer after its socket is interrupted', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'updates-'));
  roots.push(directory);
  const ranges: string[] = [];
  const server = createServer((request, response) => {
    const range = request.headers.range ?? '';
    ranges.push(range);
    if (!range) {
      response.writeHead(200, { 'Content-Length': payload.length });
      response.write(payload.subarray(0, 100_000), () =>
        setTimeout(() => response.destroy(), 50),
      );
    } else {
      const offset = Number(/^bytes=(\d+)-$/.exec(range)?.[1]);
      response.writeHead(206, {
        'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
        'Content-Length': payload.length - offset,
      });
      response.end(payload.subarray(offset));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing HTTP listener');
    const file = await fetchInstaller(
      fetch,
      { ...release(), url: `http://127.0.0.1:${address.port}/installer` },
      directory,
    );
    expect(ranges).toEqual(['', 'bytes=100000-']);
    expect(await readFile(file!)).toEqual(payload);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('resumes a saved partial installer at its exact byte offset', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'updates-'));
  roots.push(directory);
  const offset = 100_000;
  await writeFile(
    path.join(directory, 'AD-Voice-Setup-1.2.0.exe.part'),
    payload.subarray(0, offset),
  );
  const fetchImpl: typeof fetch = vi.fn(async (_url, options) => {
    expect(new Headers(options?.headers).get('Range')).toBe(`bytes=${offset}-`);
    return new Response(payload.subarray(offset), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
      },
    });
  });
  const file = await fetchInstaller(fetchImpl, release(), directory);
  expect(await readFile(file!)).toEqual(payload);
});

it('reconnects when the server stops before sending response headers', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'updates-'));
  roots.push(directory);
  vi.useFakeTimers();
  let calls = 0;
  const fetchImpl: typeof fetch = vi.fn(async (_url, options) => {
    if (++calls > 1) return new Response(payload);
    return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => reject(new Error('Connection stalled')),
        { once: true },
      );
    });
  });
  const downloading = fetchInstaller(fetchImpl, release(), directory);
  await vi.advanceTimersByTimeAsync(17_000);
  expect(calls).toBe(2);
  vi.useRealTimers();
  const file = await downloading;
  expect(await readFile(file!)).toEqual(payload);
});

it.each(['stalled', 'disconnected'])(
  'continues after a %s response body without losing saved bytes',
  async (failure) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'updates-'));
    roots.push(directory);
    vi.useFakeTimers();
    const offset = 100_000;
    let calls = 0;
    let first!: ReadableStreamDefaultController<Uint8Array>;
    const fetchImpl: typeof fetch = vi.fn(async (_url, options) => {
      if (++calls === 1)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              first = controller;
              controller.enqueue(payload.subarray(0, offset));
            },
          }),
        );
      expect(new Headers(options?.headers).get('Range')).toBe(
        `bytes=${offset}-`,
      );
      return new Response(payload.subarray(offset), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
        },
      });
    });
    const downloading = fetchInstaller(fetchImpl, release(), directory);
    await vi.waitFor(async () =>
      expect(
        (await stat(path.join(directory, 'AD-Voice-Setup-1.2.0.exe.part')))
          .size,
      ).toBe(offset),
    );
    if (failure === 'disconnected') first.error(new Error('Connection reset'));
    else await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 3000 });
    vi.useRealTimers();
    const file = await downloading;
    expect(await readFile(file!)).toEqual(payload);
  },
);

it('restarts safely when the server ignores Range', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'updates-'));
  roots.push(directory);
  await writeFile(
    path.join(directory, 'AD-Voice-Setup-1.2.0.exe.part'),
    payload.subarray(0, 1234),
  );
  const file = await fetchInstaller(serve(), release(), directory);
  expect(await readFile(file!)).toEqual(payload);
});

it('rejects a mismatched range without changing the saved prefix', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'updates-'));
  roots.push(directory);
  const partial = path.join(directory, 'AD-Voice-Setup-1.2.0.exe.part');
  const prefix = payload.subarray(0, 1234);
  await writeFile(partial, prefix);
  const fetchImpl: typeof fetch = vi.fn(
    async () =>
      new Response(payload, {
        status: 206,
        headers: {
          'Content-Range': `bytes 0-${payload.length - 1}/${payload.length}`,
        },
      }),
  );
  expect(await fetchInstaller(fetchImpl, release(), directory)).toBeNull();
  expect(await readFile(partial)).toEqual(prefix);
});

it('stops after bounded retries and retains the partial download for a later attempt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'updates-'));
  roots.push(directory);
  const partial = path.join(directory, 'AD-Voice-Setup-1.2.0.exe.part');
  await writeFile(partial, payload.subarray(0, 1234));
  vi.useFakeTimers();
  const fetchImpl = vi.fn(async () => {
    throw new Error('Offline');
  });
  const downloading = expect(
    fetchInstaller(fetchImpl, release(), directory),
  ).rejects.toThrow('Offline');
  await vi.advanceTimersByTimeAsync(20_000);
  await downloading;
  expect(fetchImpl).toHaveBeenCalledTimes(5);
  expect((await stat(partial)).size).toBe(1234);
});

it('downloads the installer with progress and reuses the verified file at the next start', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'updates-'));
  roots.push(directory);
  const fetchImpl = serve();
  const percents: number[] = [];

  const file = await fetchInstaller(
    fetchImpl as unknown as typeof fetch,
    release(),
    directory,
    (percent) => percents.push(percent),
  );

  expect(file).toBe(path.join(directory, 'AD-Voice-Setup-1.2.0.exe'));
  expect(await readFile(file!)).toEqual(payload);
  expect(percents.at(-1)).toBe(100);
  expect(percents).toEqual([...percents].sort((a, b) => a - b));

  expect(
    await fetchInstaller(
      fetchImpl as unknown as typeof fetch,
      release(),
      directory,
    ),
  ).toBe(file);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('throws away an installer that does not match the release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'updates-'));
  roots.push(directory);

  const file = await fetchInstaller(
    serve() as unknown as typeof fetch,
    release('0'.repeat(64)),
    directory,
  );

  expect(file).toBeNull();
  expect(await readdir(directory)).toEqual([]);
});
