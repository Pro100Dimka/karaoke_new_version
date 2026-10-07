import { EventEmitter } from "node:events";
import type { BrowserWindowConstructorOptions } from "electron";
import { afterEach, expect, it, vi } from "vitest";

const splashWindows = vi.hoisted(() => [] as Array<{
  options: BrowserWindowConstructorOptions;
  webContents: EventEmitter;
  visible: boolean;
}>);

vi.mock("electron", () => ({
  app: { getPath: () => "C:\\missing-profile" },
  BrowserWindow: class extends EventEmitter {
    webContents = new EventEmitter();
    visible = false;

    constructor(public options: BrowserWindowConstructorOptions) {
      super();
      splashWindows.push(this);
    }

    setBackgroundColor() {}
    setIgnoreMouseEvents() {}
    showInactive() {
      this.visible = true;
    }
    loadFile() {
      return Promise.resolve();
    }
    close() {
      this.emit("closed");
    }
  },
}));

afterEach(async () => {
  const { closeSplash } = await import("./Splash");
  closeSplash();
  splashWindows.length = 0;
});

it("shows the startup loader without adding a separate taskbar preview", async () => {
  const { openSplash } = await import("./Splash");
  openSplash(null, "C:\\app\\splash.html");

  const loader = splashWindows[0];
  expect(loader).toBeDefined();
  expect(loader.options).toMatchObject({
    transparent: true,
    show: false,
    skipTaskbar: true,
  });
  expect(loader.visible).toBe(false);

  loader.webContents.emit("did-finish-load");
  expect(loader.visible).toBe(true);
});
