import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  launchAsio4AllInstaller,
  type Asio4AllRelease,
} from './Asio4AllInstaller';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

const setup = async (
  bytes: Uint8Array,
): Promise<{ root: string; release: Asio4AllRelease }> => {
  const root = await mkdtemp(join(tmpdir(), 'asio4all-test-'));
  roots.push(root);
  return {
    root,
    release: {
      version: 'test',
      url: 'https://asio4all.org/downloads/test.exe',
      fileName: 'test.exe',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
};

it('downloads a verified official installer before launching it', async () => {
  const bytes = new TextEncoder().encode('signed installer fixture');
  const { root, release } = await setup(bytes);
  const openPath = vi.fn(async () => '');
  await launchAsio4AllInstaller(
    root,
    openPath,
    release,
    vi.fn(async () => new Response(bytes)),
  );
  const installer = join(root, release.fileName);
  expect(await readFile(installer)).toEqual(Buffer.from(bytes));
  expect(openPath).toHaveBeenCalledWith(installer);
});

it('never launches a download whose checksum does not match the pinned release', async () => {
  const bytes = new TextEncoder().encode('tampered');
  const { root, release } = await setup(bytes);
  release.sha256 = '0'.repeat(64);
  const openPath = vi.fn(async () => '');
  await expect(
    launchAsio4AllInstaller(
      root,
      openPath,
      release,
      vi.fn(async () => new Response(bytes)),
    ),
  ).rejects.toThrow(/checksum/i);
  expect(openPath).not.toHaveBeenCalled();
});

it('stops a headerless oversized download before buffering the whole response', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const { root, release } = await setup(chunk);
  const openPath = vi.fn(async () => '');
  const cancel = vi.fn();
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++chunks <= 16) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  });
  await expect(
    launchAsio4AllInstaller(
      root,
      openPath,
      release,
      vi.fn(async () => new Response(stream)),
    ),
  ).rejects.toThrow(/size|large/i);
  expect(chunks).toBeLessThan(16);
  expect(cancel).toHaveBeenCalledOnce();
  expect(openPath).not.toHaveBeenCalled();
});

it.each(['http-error', 'oversized-header'])(
  'releases an unread response rejected for %s',
  async (failure) => {
    const { root, release } = await setup(new Uint8Array([1]));
    const openPath = vi.fn(async () => '');
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: failure === 'http-error' ? 503 : 200,
      headers:
        failure === 'oversized-header'
          ? { 'content-length': String(9 * 1024 * 1024) }
          : {},
    });
    await expect(
      launchAsio4AllInstaller(
        root,
        openPath,
        release,
        vi.fn(async () => response),
      ),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(openPath).not.toHaveBeenCalled();
  },
);
