import { expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ text: "{}", written: "" }));
vi.mock("node:fs", () => ({
  readFileSync: () => saved.text,
  writeFileSync: (_path: string, text: string) => { saved.written = text; },
}));
vi.mock("electron", () => ({
  app: { getPath: () => "D:/isolated-profile" },
  screen: { getAllDisplays: () => [
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
  ] },
}));

import type { BrowserWindow } from "electron";
import { loadWindowState, saveWindowState } from "./WindowState";

it.each(["width", "height"] as const)("repairs invalid saved %s without discarding valid placement", (dimension) => {
  for (const value of [-1, 0, 0.5, "Infinity", "1280", true, [], null]) {
    saved.text = JSON.stringify({ width: 1280, height: 720, x: -1600, y: 40, maximized: true, [dimension]: value });
    expect(loadWindowState()).toEqual({
      width: 1280, height: 720, x: -1600, y: 40, maximized: true, fullscreen: false,
      [dimension]: dimension === "width" ? 1440 : 900,
    });
  }
});

it("repairs overflowing JSON dimensions before creating the native window", () => {
  saved.text = '{"width":1e400,"height":720,"maximized":false}';
  expect(loadWindowState()).toEqual({ width: 1440, height: 720, maximized: false, fullscreen: false });
});

it("preserves valid small dimensions and negative coordinates on a connected display", () => {
  saved.text = JSON.stringify({ width: 500, height: 300, x: -1600, y: 40 });
  expect(loadWindowState()).toEqual({ width: 500, height: 300, x: -1600, y: 40, maximized: false, fullscreen: false });
});

it("centers a saved window when its former display is disconnected", () => {
  saved.text = JSON.stringify({ width: 1280, height: 720, x: -5000, y: 40 });
  expect(loadWindowState()).toEqual({ width: 1280, height: 720, maximized: false, fullscreen: false });
});

it("remembers full screen with the normal bounds to return to", () => {
  const window = {
    isMaximized: () => false,
    isFullScreen: () => true,
    getNormalBounds: () => ({ x: 100, y: 80, width: 1280, height: 720 }),
    getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
  } as unknown as BrowserWindow;
  saveWindowState(window);
  expect(JSON.parse(saved.written)).toEqual({ width: 1280, height: 720, x: 100, y: 80, maximized: false, fullscreen: true });
  saved.text = saved.written;
  expect(loadWindowState()).toMatchObject({ fullscreen: true, width: 1280, height: 720 });
  for (const value of ["true", 1, null]) {
    saved.text = JSON.stringify({ width: 1280, height: 720, fullscreen: value });
    expect(loadWindowState().fullscreen).toBe(false);
  }
});
