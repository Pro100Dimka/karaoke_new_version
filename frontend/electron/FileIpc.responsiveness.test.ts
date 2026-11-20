import { setImmediate } from 'node:timers/promises';
import * as path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { registerDesktopIpc } from './DesktopIpc';
import { registerProjectFileHandlers } from './ProjectFiles';
import { fetchInstaller } from './AutoUpdate';
import { ipcChannels } from './ipcChannels';
import type { TrustedIpc } from './TrustedIpc';

const disk = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  stat: vi.fn(),
  readSync: vi.fn(),
  writeSync: vi.fn(),
  statSync: vi.fn(),
}));
const saveDialog = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (original) => {
  const mocked = {
    ...(await original<typeof import('node:fs')>()),
    readFileSync: disk.readSync,
    writeFileSync: disk.writeSync,
    statSync: disk.statSync,
  };
  return { ...mocked, default: mocked };
});
vi.mock('node:fs/promises', async (original) => {
  const mocked = {
    ...(await original<typeof import('node:fs/promises')>()),
    readFile: disk.read,
    writeFile: disk.write,
    stat: disk.stat,
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

const root = path.resolve('slow-song-storage');
const manifest = JSON.stringify({
  artifacts: [{ logicalName: 'instrumental', relativePath: 'minus.wav' }],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};
const setup = () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) =>
      handlers.set(channel, listener),
  } as unknown as TrustedIpc;
  const minimize = vi.fn();
  const peaks = vi.fn().mockResolvedValue([0.2, 1]);
  const request = vi.fn();
  registerDesktopIpc({
    trustedIpc: ipc,
    window: () => ({ minimize }) as never,
    storageRoot: () => root,
    reveal: vi.fn(),
    confirmClose: vi.fn(),
    requestRelaunch: vi.fn(),
  });
  registerProjectFileHandlers(() => root, { request } as never, ipc, peaks);
  return {
    minimize,
    peaks,
    request,
    invoke: (channel: string, ...args: unknown[]) => {
      const result = Promise.resolve().then(() =>
        handlers.get(channel)!({}, ...args),
      );
      void result.catch(() => undefined);
      return result;
    },
  };
};

beforeEach(() => {
  vi.resetAllMocks();
  disk.readSync.mockReturnValue(manifest);
  disk.statSync.mockReturnValue({ isFile: () => true, size: 123 });
  saveDialog.mockResolvedValue({
    canceled: false,
    filePath: path.join(root, 'export.txt'),
  });
});

it.each([ipcChannels.resolveProjectArtifacts, ipcChannels.waveformPeaks])(
  '%s leaves window controls available while a project disk read is pending',
  async (channel) => {
    const read = deferred<string>();
    disk.read.mockReturnValue(read.promise);
    const { invoke, minimize, peaks, request } = setup();
    let settled = false;
    const result = invoke(channel, { songId: 'song', revision: 2, bins: 64 });
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
      await invoke(ipcChannels.minimize);
      expect(minimize).toHaveBeenCalledOnce();
      expect(disk.readSync).not.toHaveBeenCalled();
      expect(disk.read).toHaveBeenCalledExactlyOnceWith(
        path.join(root, 'songs', 'song', 'revisions', '2', 'manifest.json'),
        'utf8',
      );
      expect(settled).toBe(false);
      expect(peaks).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      read.resolve(manifest);
    }
    const instrumental = path.join(
      root,
      'songs',
      'song',
      'revisions',
      '2',
      'minus.wav',
    );
    if (channel === ipcChannels.resolveProjectArtifacts)
      await expect(result).resolves.toMatchObject({ instrumental });
    else {
      await expect(result).resolves.toEqual([0.2, 1]);
      expect(peaks).toHaveBeenCalledExactlyOnceWith(instrumental, 64);
    }
  },
);

it('keeps file metadata lookup asynchronous for slow external storage', async () => {
  const lookup = deferred<{ isFile(): boolean; size: number }>();
  disk.stat.mockReturnValue(lookup.promise);
  const { invoke, minimize } = setup();
  const file = path.join(root, 'track.FLAC');
  const result = invoke(ipcChannels.statFile, file);
  try {
    await setImmediate();
    await invoke(ipcChannels.minimize);
    expect(minimize).toHaveBeenCalledOnce();
    expect(disk.statSync).not.toHaveBeenCalled();
    expect(disk.stat).toHaveBeenCalledExactlyOnceWith(file);
  } finally {
    lookup.resolve({ isFile: () => true, size: 123 });
  }
  await expect(result).resolves.toEqual({
    name: 'track.FLAC',
    extension: 'flac',
    sizeBytes: 123,
  });
});

it('keeps window controls responsive while checking a cached update on a busy disk', async () => {
  const lookup = deferred<{ size: number }>();
  disk.stat.mockReturnValue(lookup.promise);
  const { invoke, minimize } = setup();
  const download = vi.fn();
  let settled = false;
  const result = fetchInstaller(
    download,
    {
      version: '1.2.0',
      url: 'https://github.com/example/installer.exe',
      size: 1,
      sha256: '0'.repeat(64),
    },
    root,
    undefined,
    false,
  );
  void result.then(() => {
    settled = true;
  });
  try {
    await setImmediate();
    await invoke(ipcChannels.minimize);
    expect(minimize).toHaveBeenCalledOnce();
    expect(disk.statSync).not.toHaveBeenCalled();
    expect(disk.stat).toHaveBeenCalledExactlyOnceWith(
      path.join(root, 'AD-Voice-Setup-1.2.0.exe'),
    );
    expect(settled).toBe(false);
    expect(download).not.toHaveBeenCalled();
  } finally {
    lookup.resolve({ size: 0 });
  }
  await expect(result).resolves.toBeNull();
});

it('waits for a text export to finish without blocking other window requests', async () => {
  const write = deferred<void>();
  disk.write.mockReturnValue(write.promise);
  const { invoke, minimize } = setup();
  let settled = false;
  const result = invoke(ipcChannels.saveTextFile, {
    defaultName: 'lyrics.txt',
    content: 'текст',
  });
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
    await invoke(ipcChannels.minimize);
    expect(minimize).toHaveBeenCalledOnce();
    expect(disk.writeSync).not.toHaveBeenCalled();
    expect(disk.write).toHaveBeenCalledExactlyOnceWith(
      path.join(root, 'export.txt'),
      'текст',
      'utf8',
    );
    expect(settled).toBe(false);
  } finally {
    write.resolve();
  }
  await expect(result).resolves.toBe(true);
});

it('retains artifact path validation after the asynchronous manifest read', async () => {
  disk.read.mockResolvedValue(
    JSON.stringify({
      artifacts: [
        { logicalName: 'instrumental', relativePath: '../../outside.wav' },
      ],
    }),
  );
  const { invoke } = setup();
  await expect(
    invoke(ipcChannels.resolveProjectArtifacts, {
      songId: 'song',
      revision: 2,
    }),
  ).rejects.toThrow('Project artifact escapes revision root');
});

it('rejects disk failures and directories instead of reporting successful operations', async () => {
  disk.stat.mockResolvedValue({ isFile: () => false });
  disk.write.mockRejectedValue(new Error('Disk unavailable'));
  const { invoke } = setup();
  await expect(invoke(ipcChannels.statFile, root)).rejects.toThrow(
    'Not a file',
  );
  await expect(
    invoke(ipcChannels.saveTextFile, {
      defaultName: 'lyrics.txt',
      content: 'text',
    }),
  ).rejects.toThrow('Disk unavailable');
});
