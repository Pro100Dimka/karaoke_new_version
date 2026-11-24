import { beforeEach, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => ({ text: '{}', written: '' }));
const disk = vi.hoisted(() => ({ sync: vi.fn(), write: vi.fn() }));
vi.mock('node:fs', () => ({
  readFileSync: () => saved.text,
  writeFileSync: (_path: string, text: string) => {
    disk.sync();
    saved.written = text;
  },
}));
vi.mock('node:fs/promises', () => ({
  default: { writeFile: disk.write },
  writeFile: disk.write,
}));
vi.mock('electron', () => ({
  app: { getPath: () => 'D:/isolated-profile' },
  screen: {
    getAllDisplays: () => [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
    ],
  },
}));

import type { BrowserWindow } from 'electron';
import {
  flushWindowState,
  loadWindowState,
  saveWindowState,
} from './WindowState';

beforeEach(() => {
  disk.sync.mockClear();
  disk.write.mockReset().mockImplementation(async (_path, text) => {
    saved.written = text;
  });
});

const placed = (x: number) =>
  ({
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => ({ x, y: 80, width: 1280, height: 720 }),
  }) as BrowserWindow;

it('keeps close handling free of synchronous disk writes', async () => {
  const saving = saveWindowState(placed(10));
  await saving;
  expect(disk.sync).not.toHaveBeenCalled();
  expect(disk.write).toHaveBeenCalledOnce();
  expect(JSON.parse(saved.written).x).toBe(10);
});

it('keeps only the latest pending placement while a slow write is in flight', async () => {
  const writes: { text: string; finish(): void }[] = [];
  disk.write.mockImplementation(
    (_path, text: string) =>
      new Promise<void>((resolve) => {
        writes.push({ text, finish: resolve });
      }),
  );
  const first = saveWindowState(placed(0));
  await Promise.resolve();
  let flushed = false;
  const flushing = flushWindowState().then(() => {
    flushed = true;
  });
  const pending = Array.from({ length: 100 }, (_, index) =>
    saveWindowState(placed(index + 1)),
  );
  try {
    expect(disk.sync).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(flushed).toBe(false);
    expect(JSON.parse(writes[0]!.text).x).toBe(0);
    writes[0]!.finish();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(flushed).toBe(false);
    expect(JSON.parse(writes[1]!.text).x).toBe(100);
    writes[1]!.finish();
    await Promise.all([first, flushing, ...pending]);
    expect(flushed).toBe(true);
    expect(writes).toHaveLength(2);
  } finally {
    disk.write.mockResolvedValue(undefined);
    for (const write of writes) write.finish();
    await Promise.all([first, ...pending]);
  }
});

it('allows a later save after a failed disk write without rejecting close', async () => {
  disk.write.mockRejectedValueOnce(new Error('Read only profile'));
  await saveWindowState(placed(10));
  await saveWindowState(placed(20));
  expect(disk.write).toHaveBeenCalledTimes(2);
  expect(JSON.parse(saved.written).x).toBe(20);
});

it.each(['width', 'height'] as const)(
  'repairs invalid saved %s without discarding valid placement',
  (dimension) => {
    for (const value of [-1, 0, 0.5, 'Infinity', '1280', true, [], null]) {
      saved.text = JSON.stringify({
        width: 1280,
        height: 720,
        x: -1600,
        y: 40,
        maximized: true,
        [dimension]: value,
      });
      expect(loadWindowState()).toEqual({
        width: 1280,
        height: 720,
        x: -1600,
        y: 40,
        maximized: true,
        fullscreen: false,
        [dimension]: dimension === 'width' ? 1440 : 900,
      });
    }
  },
);

it('repairs overflowing JSON dimensions before creating the native window', () => {
  saved.text = '{"width":1e400,"height":720,"maximized":false}';
  expect(loadWindowState()).toEqual({
    width: 1440,
    height: 720,
    maximized: false,
    fullscreen: false,
  });
});

it('preserves valid small dimensions and negative coordinates on a connected display', () => {
  saved.text = JSON.stringify({ width: 500, height: 300, x: -1600, y: 40 });
  expect(loadWindowState()).toEqual({
    width: 500,
    height: 300,
    x: -1600,
    y: 40,
    maximized: false,
    fullscreen: false,
  });
});

it('centers a saved window when its former display is disconnected', () => {
  saved.text = JSON.stringify({ width: 1280, height: 720, x: -5000, y: 40 });
  expect(loadWindowState()).toEqual({
    width: 1280,
    height: 720,
    maximized: false,
    fullscreen: false,
  });
});

it('remembers full screen with the normal bounds to return to', async () => {
  const window = {
    isMaximized: () => false,
    isFullScreen: () => true,
    getNormalBounds: () => ({ x: 100, y: 80, width: 1280, height: 720 }),
    getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
  } as unknown as BrowserWindow;
  await saveWindowState(window);
  expect(JSON.parse(saved.written)).toEqual({
    width: 1280,
    height: 720,
    x: 100,
    y: 80,
    maximized: false,
    fullscreen: true,
  });
  saved.text = saved.written;
  expect(loadWindowState()).toMatchObject({
    fullscreen: true,
    width: 1280,
    height: 720,
  });
  for (const value of ['true', 1, null]) {
    saved.text = JSON.stringify({
      width: 1280,
      height: 720,
      fullscreen: value,
    });
    expect(loadWindowState().fullscreen).toBe(false);
  }
});
