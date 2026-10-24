import { EventEmitter } from "node:events";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { expect, it, vi } from "vitest";
import type { TrustedIpc } from "./TrustedIpc";

vi.mock("electron", () => ({
  BrowserWindow: class extends EventEmitter {
    private visible: boolean;
    private maximized = false;
    private fullscreen = false;
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    });

    static lastOptions: BrowserWindowConstructorOptions | undefined;
    constructor(options: BrowserWindowConstructorOptions) {
      super();
      this.visible = options.show !== false;
      (this.constructor as { lastOptions?: BrowserWindowConstructorOptions }).lastOptions = options;
    }

    isDestroyed() {
      return false;
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return false;
    }
    isMaximized() {
      return this.maximized;
    }
    show() {
      if (this.visible) return;
      this.visible = true;
      this.emit("show");
    }
    maximize() {
      this.maximized = true;
      // Electron also shows a hidden window when it is maximized.
      this.show();
    }
    isFullScreen() {
      return this.fullscreen;
    }
    setFullScreen(value: boolean) {
      this.fullscreen = value;
      this.show();
    }
    loadURL() {
      return Promise.resolve();
    }
  },
}));
vi.mock("./AppPaths", () => ({ themeIconPath: () => null }));
vi.mock("./Splash", () => ({ readSavedTheme: () => "dark" }));
const savedState = vi.hoisted(() => ({ maximized: true, fullscreen: false }));
vi.mock("./WindowState", () => ({
  loadWindowState: () => ({ width: 1280, height: 720, ...savedState }),
  saveWindowState: vi.fn(),
  publishWindowState: vi.fn(),
}));
vi.mock("./PanelWindows", () => ({
  panelWindowOpenHandler: () => vi.fn(),
  securePanelWindow: vi.fn(),
}));
vi.mock("./AppVisibility", () => ({
  watchAppVisibility: () => ({ republish: vi.fn(), addPanel: vi.fn() }),
}));

it("keeps a saved maximized main window hidden behind the loader until reveal", async () => {
  const { createMainWindow } = await import("./MainWindow");
  let mainWindow!: BrowserWindow;
  let loaderVisible = true;
  const reveal = () => {
    mainWindow.show();
    loaderVisible = false;
  };
  mainWindow = createMainWindow({
    rendererUrl: "file:///app/index.html",
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: "participant",
    closeConfirmed: () => false,
    reveal,
  });

  expect(loaderVisible).toBe(true);
  expect(mainWindow.isVisible()).toBe(false);
  reveal();
  expect(loaderVisible).toBe(false);
  expect(mainWindow.isVisible()).toBe(true);
  expect(mainWindow.isMaximized()).toBe(true);
});

it("reopens full screen behind the loader when the window was closed full screen", async () => {
  savedState.fullscreen = true;
  try {
    const { createMainWindow } = await import("./MainWindow");
    const mainWindow = createMainWindow({
      rendererUrl: "file:///app/index.html",
      trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
      roomParticipant: "participant",
      closeConfirmed: () => false,
      reveal: vi.fn(),
    });
    expect(mainWindow.isVisible()).toBe(false);
    expect(mainWindow.isFullScreen()).toBe(false);
    mainWindow.show();
    expect(mainWindow.isFullScreen()).toBe(true);
    // Full screen supersedes the saved maximize; leaving it returns to the saved bounds.
    expect(mainWindow.isMaximized()).toBe(false);
  } finally {
    savedState.fullscreen = false;
  }
});

it("turns off spell checking: no underlines and no dictionary downloads", async () => {
  const { createMainWindow } = await import("./MainWindow");
  const { BrowserWindow } = await import("electron");
  createMainWindow({
    rendererUrl: "file:///app/index.html",
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: "participant",
    closeConfirmed: () => false,
    reveal: vi.fn(),
  });
  expect((BrowserWindow as unknown as { lastOptions: BrowserWindowConstructorOptions }).lastOptions.webPreferences?.spellcheck).toBe(false);
});

it("publishes the explicit fullscreen transition even when Windows reports its previous flag during the event", async () => {
  const { createMainWindow } = await import("./MainWindow");
  const { publishWindowState } = await import("./WindowState");
  const window = createMainWindow({
    rendererUrl: "file:///app/index.html", trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: "participant", closeConfirmed: () => false, reveal: vi.fn(),
  });
  expect(window.isFullScreen()).toBe(false);
  window.emit("enter-full-screen");
  expect(publishWindowState).toHaveBeenLastCalledWith(window, { fullscreen: true });
  window.setFullScreen(true);
  window.emit("leave-full-screen");
  expect(publishWindowState).toHaveBeenLastCalledWith(window, { fullscreen: false });
});

it("fills the window with the saved theme's colour until the interface paints", async () => {
  const { createMainWindow, themeWindowBackground } = await import("./MainWindow");
  const { BrowserWindow } = await import("electron");
  createMainWindow({
    rendererUrl: "file:///app/index.html",
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: "participant",
    closeConfirmed: () => false,
    reveal: vi.fn(),
  });
  // The test's saved theme is "dark".
  expect((BrowserWindow as unknown as { lastOptions: BrowserWindowConstructorOptions }).lastOptions.backgroundColor).toBe(themeWindowBackground.dark);
  expect(Object.keys(themeWindowBackground).sort()).toEqual(["dark", "green", "light", "violet"]);
});

it("forwards renderer and detached panel console errors to the app log", async () => {
  const { createMainWindow } = await import("./MainWindow");
  const log = vi.fn();
  const window = createMainWindow({
    rendererUrl: "file:///app/index.html",
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: "participant",
    closeConfirmed: () => false,
    reveal: vi.fn(),
    log,
  });
  window.webContents.emit("console-message", { level: "error", message: "renderer failed" });
  const panel = { webContents: new EventEmitter() } as unknown as BrowserWindow;
  window.webContents.emit("did-create-window", panel);
  panel.webContents.emit("console-message", { level: "warning", message: "panel lag" });
  expect(log.mock.calls).toEqual([
    ["renderer", "error", "renderer failed"],
    ["renderer", "warning", "panel lag"],
  ]);
});

it("reports renderer hangs and recovery in the central log", async () => {
  const { createMainWindow } = await import("./MainWindow");
  const log = vi.fn();
  const window = createMainWindow({
    rendererUrl: "file:///app/index.html",
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: "participant",
    closeConfirmed: () => false,
    reveal: vi.fn(),
    log,
  });
  window.emit("unresponsive");
  window.emit("responsive");
  expect(log.mock.calls).toEqual([
    ["renderer", "warning", "Renderer unresponsive"],
    ["renderer", "info", "Renderer responsive"],
  ]);
});

it("records a failed renderer load before revealing the error window", async () => {
  const { createMainWindow } = await import("./MainWindow");
  const log = vi.fn();
  const reveal = vi.fn();
  const window = createMainWindow({
    rendererUrl: "file:///app/index.html",
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: "participant",
    closeConfirmed: () => false,
    reveal,
    log,
  });
  window.webContents.emit("did-fail-load", {}, -6, "File not found");
  expect(log).toHaveBeenCalledWith("renderer", "error", "Renderer failed to load (-6): File not found");
  expect(reveal).toHaveBeenCalledOnce();
});

it("allows a failed main document to close, but preserves guards for subframes and after recovery", async () => {
  const { createMainWindow } = await import("./MainWindow");
  const window = createMainWindow({
    rendererUrl: "file:///app/index.html",
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: "participant", closeConfirmed: () => false, reveal: vi.fn(),
  });
  const close = { preventDefault: vi.fn() };
  window.webContents.emit("did-fail-load", {}, -6, "File not found", "file:///app/frame.html", false);
  window.emit("close", close);
  expect(close.preventDefault).toHaveBeenCalledOnce();
  close.preventDefault.mockClear();

  window.webContents.emit("did-fail-load", {}, -6, "File not found", "file:///app/index.html", true);
  window.emit("close", close);
  expect(close.preventDefault).not.toHaveBeenCalled();

  window.webContents.emit("did-finish-load");
  window.emit("close", close);
  expect(close.preventDefault).toHaveBeenCalledOnce();
});
