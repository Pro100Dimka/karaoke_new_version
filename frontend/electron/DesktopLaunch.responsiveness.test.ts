import * as path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startDesktopLaunch } from './DesktopLaunch';
import { DesktopShell } from './DesktopShell';

const io = vi.hoisted(() => ({ stat: vi.fn(), statSync: vi.fn() }));
vi.mock('node:fs', async (original) => {
  const mocked = {
    ...(await original<typeof import('node:fs')>()),
    statSync: io.statSync,
  };
  return { ...mocked, default: mocked };
});
vi.mock('node:fs/promises', async (original) => {
  const mocked = {
    ...(await original<typeof import('node:fs/promises')>()),
    stat: io.stat,
  };
  return { ...mocked, default: mocked };
});
vi.mock('electron', () => ({
  app: { isPackaged: false, setUserTasks: vi.fn() },
  globalShortcut: { register: () => true, unregister: vi.fn() },
  screen: { getAllDisplays: () => [], on: vi.fn() },
  powerMonitor: { isOnBatteryPower: () => false, on: vi.fn() },
}));

const originalArguments = process.argv;
beforeEach(() => {
  process.argv = ['AD Voice.exe'];
  io.statSync.mockReturnValue({ isFile: () => true });
  io.stat.mockResolvedValue({ isFile: () => true });
});
afterEach(() => {
  process.argv = originalArguments;
  vi.resetAllMocks();
});

it('keeps desktop commands responsive while launch files wait on disk', async () => {
  let release!: () => void;
  const disk = new Promise<void>((resolve) => {
    release = resolve;
  });
  io.stat.mockImplementation(async () => {
    await disk;
    return { isFile: () => true };
  });
  const shell = new DesktopShell();
  const delivered = vi.fn();
  shell.connect(delivered);
  const launch = startDesktopLaunch(shell, vi.fn());
  delivered.mockClear();
  const file = path.resolve('slow-drive.wav');
  try {
    launch.secondLaunch(['AD Voice.exe', file]);
    shell.send({ type: 'addSong' });
    await setImmediate();
    expect(delivered.mock.calls).toEqual([[{ type: 'addSong' }]]);
    expect(io.statSync).not.toHaveBeenCalled();
    expect(io.stat).toHaveBeenCalledExactlyOnceWith(file);
    release();
    await vi.waitFor(() =>
      expect(delivered).toHaveBeenLastCalledWith({
        type: 'importFiles',
        paths: [file],
      }),
    );
  } finally {
    release();
    launch.stop();
  }
});

it('preserves launch order, ignores missing files and checks each canonical path once', async () => {
  let release!: () => void;
  const disk = new Promise<void>((resolve) => {
    release = resolve;
  });
  const file = path.resolve('first.wav');
  const missing = path.resolve('missing.wav');
  io.stat.mockImplementation(async (candidate: string) => {
    await disk;
    if (candidate === missing) throw new Error('missing');
    return { isFile: () => true };
  });
  const shell = new DesktopShell();
  const delivered = vi.fn();
  shell.connect(delivered);
  const launch = startDesktopLaunch(shell, vi.fn());
  delivered.mockClear();
  try {
    launch.secondLaunch(['AD Voice.exe', missing, missing, file, file]);
    launch.secondLaunch(['AD Voice.exe', '--add-song']);
    await setImmediate();
    expect(delivered).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(2));
    expect(delivered.mock.calls).toEqual([
      [{ type: 'importFiles', paths: [file] }],
      [{ type: 'addSong' }],
    ]);
    expect(io.stat).toHaveBeenCalledTimes(2);
  } finally {
    release();
    launch.stop();
  }
});

it('does not deliver a pending launch after desktop shutdown', async () => {
  let release!: () => void;
  const disk = new Promise<void>((resolve) => {
    release = resolve;
  });
  io.stat.mockImplementation(async () => {
    await disk;
    return { isFile: () => true };
  });
  const shell = new DesktopShell();
  const delivered = vi.fn();
  shell.connect(delivered);
  const launch = startDesktopLaunch(shell, vi.fn());
  delivered.mockClear();
  try {
    launch.secondLaunch(['AD Voice.exe', path.resolve('first.wav')]);
    await setImmediate();
    launch.stop();
    release();
    await setImmediate();
    expect(delivered).not.toHaveBeenCalled();
  } finally {
    release();
    launch.stop();
  }
});

it('caps asynchronous bulk imports at fifty existing files after missing and duplicate paths', async () => {
  const missing = path.resolve('missing.wav');
  io.stat.mockImplementation(async (file: string) => {
    if (file === missing) throw new Error('missing');
    return { isFile: () => true };
  });
  const files = Array.from({ length: 51 }, (_, index) =>
    path.resolve(`track-${index}.wav`),
  );
  const shell = new DesktopShell();
  const delivered = vi.fn();
  shell.connect(delivered);
  const launch = startDesktopLaunch(shell, vi.fn());
  delivered.mockClear();
  try {
    launch.secondLaunch([
      'AD Voice.exe',
      missing,
      missing,
      ...files,
      '--add-song',
    ]);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(2));
    expect(delivered.mock.calls).toEqual([
      [{ type: 'addSong' }],
      [{ type: 'importFiles', paths: files.slice(0, 50) }],
    ]);
    expect(io.stat).toHaveBeenCalledTimes(51);
    expect(io.statSync).not.toHaveBeenCalled();
  } finally {
    launch.stop();
  }
});
