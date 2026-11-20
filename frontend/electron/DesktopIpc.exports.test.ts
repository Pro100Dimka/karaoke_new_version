import * as path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { registerDesktopIpc } from './DesktopIpc';
import { ipcChannels } from './ipcChannels';
import type { TrustedIpc } from './TrustedIpc';

const disk = vi.hoisted(() => ({ write: vi.fn() }));
const saveDialog = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (original) => {
  const mocked = {
    ...(await original<typeof import('node:fs/promises')>()),
    writeFile: disk.write,
  };
  return { ...mocked, default: mocked };
});
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  dialog: { showSaveDialog: saveDialog },
}));
vi.mock('./Asio4AllInstaller', () => ({ launchAsio4AllInstaller: vi.fn() }));
vi.mock('./AppPaths', () => ({
  projectRoot: vi.fn(),
  saveStorageRoot: vi.fn(),
  themeIconPath: vi.fn(),
}));
vi.mock('./SceneProtocol', () => ({ pickSceneClip: vi.fn() }));
vi.mock('./Splash', () => ({ isThemeName: vi.fn(), saveTheme: vi.fn() }));

const root = path.resolve('slow-export-storage');
const filePath = path.join(root, 'report.json');
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const setup = () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const trustedIpc = {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) =>
      handlers.set(channel, listener),
  } as unknown as TrustedIpc;
  registerDesktopIpc({
    trustedIpc,
    window: () => ({}) as never,
    storageRoot: () => root,
    reveal: vi.fn(),
    confirmClose: vi.fn(),
    requestRelaunch: vi.fn(),
  });
  return (content: string) => {
    const result = Promise.resolve().then(() =>
      handlers.get(ipcChannels.saveTextFile)!(
        {},
        {
          defaultName: 'report.json',
          content,
        },
      ),
    );
    void result.catch(() => undefined);
    return result;
  };
};

beforeEach(() => {
  vi.resetAllMocks();
  saveDialog.mockResolvedValue({ canceled: false, filePath });
});

it.each([
  filePath,
  `${root}${path.sep}nested${path.sep}..${path.sep}report.json`,
])(
  'serializes overlapping exports to the same normalized path %s and retains later queued work',
  async (secondPath) => {
    const firstWrite = deferred();
    const secondWrite = deferred();
    disk.write.mockImplementation((_path: string, content: string) =>
      content === 'first'
        ? firstWrite.promise
        : content === 'second'
          ? secondWrite.promise
          : Promise.resolve(),
    );
    saveDialog
      .mockResolvedValueOnce({ canceled: false, filePath })
      .mockResolvedValueOnce({ canceled: false, filePath: secondPath });
    const save = setup();
    const first = save('first');
    const second = save('second');
    const requests = [first, second];
    try {
      await setImmediate();
      expect(disk.write.mock.calls).toEqual([[filePath, 'first', 'utf8']]);
      firstWrite.resolve();
      await expect(first).resolves.toBe(true);
      await setImmediate();
      expect(disk.write.mock.calls.map((call) => call[1])).toEqual([
        'first',
        'second',
      ]);
      requests.push(save('third'));
      await setImmediate();
      expect(disk.write).toHaveBeenCalledTimes(2);
      secondWrite.resolve();
      await expect(Promise.all(requests)).resolves.toEqual([true, true, true]);
      expect(disk.write.mock.calls.map((call) => call[1])).toEqual([
        'first',
        'second',
        'third',
      ]);
    } finally {
      firstWrite.resolve();
      secondWrite.resolve();
      await Promise.allSettled(requests);
    }
  },
);

it('rejects a failed export while continuing the next write for that path', async () => {
  const failedWrite = deferred();
  disk.write.mockImplementation((_path: string, content: string) =>
    content === 'first' ? failedWrite.promise : Promise.resolve(),
  );
  const save = setup();
  const first = save('first');
  const second = save('second');
  const result = Promise.allSettled([first, second]);
  try {
    await setImmediate();
    expect(disk.write).toHaveBeenCalledTimes(1);
    failedWrite.reject(new Error('Disk unavailable'));
    expect(await result).toEqual([
      { status: 'rejected', reason: new Error('Disk unavailable') },
      { status: 'fulfilled', value: true },
    ]);
    await expect(save('third')).resolves.toBe(true);
    expect(disk.write.mock.calls.map((call) => call[1])).toEqual([
      'first',
      'second',
      'third',
    ]);
  } finally {
    failedWrite.resolve();
    await result;
  }
});

it('allows exports to different files to finish independently', async () => {
  const blocked = deferred();
  disk.write.mockImplementation((_path: string, content: string) =>
    content === 'first' ? blocked.promise : Promise.resolve(),
  );
  const otherPath = path.join(root, 'other.json');
  saveDialog
    .mockResolvedValueOnce({ canceled: false, filePath })
    .mockResolvedValueOnce({ canceled: false, filePath: otherPath });
  const save = setup();
  const first = save('first');
  const second = save('second');
  try {
    await expect(second).resolves.toBe(true);
    expect(disk.write.mock.calls).toEqual([
      [filePath, 'first', 'utf8'],
      [otherPath, 'second', 'utf8'],
    ]);
  } finally {
    blocked.resolve();
    await first;
  }
});
