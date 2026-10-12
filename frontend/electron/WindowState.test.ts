import { expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ text: "{}" }));
vi.mock("node:fs", () => ({ readFileSync: () => saved.text }));
vi.mock("electron", () => ({
  app: { getPath: () => "D:/isolated-profile" },
  screen: { getAllDisplays: () => [
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
  ] },
}));

import { loadWindowState } from "./WindowState";

it.each(["width", "height"] as const)("repairs invalid saved %s without discarding valid placement", (dimension) => {
  for (const value of [-1, 0, 0.5, "Infinity", "1280", true, [], null]) {
    saved.text = JSON.stringify({ width: 1280, height: 720, x: -1600, y: 40, maximized: true, [dimension]: value });
    expect(loadWindowState()).toEqual({
      width: 1280, height: 720, x: -1600, y: 40, maximized: true,
      [dimension]: dimension === "width" ? 1440 : 900,
    });
  }
});

it("repairs overflowing JSON dimensions before creating the native window", () => {
  saved.text = '{"width":1e400,"height":720,"maximized":false}';
  expect(loadWindowState()).toEqual({ width: 1440, height: 720, maximized: false });
});

it("preserves valid small dimensions and negative coordinates on a connected display", () => {
  saved.text = JSON.stringify({ width: 500, height: 300, x: -1600, y: 40 });
  expect(loadWindowState()).toEqual({ width: 500, height: 300, x: -1600, y: 40, maximized: false });
});

it("centers a saved window when its former display is disconnected", () => {
  saved.text = JSON.stringify({ width: 1280, height: 720, x: -5000, y: 40 });
  expect(loadWindowState()).toEqual({ width: 1280, height: 720, maximized: false });
});
