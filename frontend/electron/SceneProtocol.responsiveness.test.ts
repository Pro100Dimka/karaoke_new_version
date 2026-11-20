import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import * as path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { pickSceneClip, registerSceneProtocol } from './SceneProtocol';

const io = vi.hoisted(() => ({
  stat: vi.fn(),
  readdir: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
  stream: vi.fn(),
  handler: undefined as
    ((request: Request) => Response | Promise<Response>) | undefined,
}));
vi.mock('electron', () => ({
  app: { isPackaged: false },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: (_scheme: string, handler: typeof io.handler) => {
      io.handler = handler;
    },
  },
}));
vi.mock('node:fs', async (original) => {
  const mocked = {
    ...(await original<typeof import('node:fs')>()),
    statSync: io.statSync,
    readdirSync: io.readdirSync,
    existsSync: () => true,
    createReadStream: io.stream,
  };
  return { ...mocked, default: mocked };
});
vi.mock('node:fs/promises', async (original) => {
  const mocked = {
    ...(await original<typeof import('node:fs/promises')>()),
    stat: io.stat,
    readdir: io.readdir,
  };
  return { ...mocked, default: mocked };
});

const root = path.resolve('scene-test-project');
beforeEach(() => {
  vi.resetAllMocks();
  io.statSync.mockReturnValue({ size: 16 });
  io.readdirSync.mockReturnValue(['backdrop.webm']);
  io.stream.mockImplementation(() => Readable.from([Buffer.alloc(16)]));
  registerSceneProtocol(root);
});

it('yields while scene metadata is on disk, then returns the same streamed response', async () => {
  let complete!: (value: { size: number }) => void;
  io.stat.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  let settled = false;
  const result = Promise.resolve().then(() =>
    io.handler!(new Request('scene://local/backdrop.webm')),
  );
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await setImmediate();
    expect(io.statSync).not.toHaveBeenCalled();
    expect(io.stat).toHaveBeenCalledExactlyOnceWith(
      path.join(root, 'frontend', 'media', 'scene', 'backdrop.webm'),
    );
    expect(settled).toBe(false);
    expect(io.stream).not.toHaveBeenCalled();
  } finally {
    complete({ size: 16 });
  }
  const response = await result;
  expect(response.status).toBe(200);
  expect(response.headers.get('content-length')).toBe('16');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array(16),
  );
});

it('yields while choosing a backdrop from a slow directory', async () => {
  let complete!: (value: string[]) => void;
  io.readdir.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const result = Promise.resolve().then(() => pickSceneClip(root));
  try {
    await setImmediate();
    expect(io.readdirSync).not.toHaveBeenCalled();
    expect(io.readdir).toHaveBeenCalledExactlyOnceWith(
      path.join(root, 'frontend', 'media', 'scene'),
    );
  } finally {
    complete(['ignored.txt', 'scene one.webm']);
  }
  await expect(result).resolves.toBe('scene://local/scene%20one.webm');
});

it('keeps a missing backdrop optional and propagates a directory access failure', async () => {
  io.readdir.mockRejectedValueOnce(
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  );
  await expect(pickSceneClip(root)).resolves.toBeNull();
  io.readdir.mockRejectedValueOnce(
    Object.assign(new Error('access denied'), { code: 'EACCES' }),
  );
  await expect(pickSceneClip(root)).rejects.toThrow('access denied');
  io.stat.mockRejectedValueOnce(new Error('missing'));
  const response = await io.handler!(new Request('scene://local/missing.webm'));
  expect(response.status).toBe(404);
});
