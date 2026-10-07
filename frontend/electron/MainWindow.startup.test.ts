import { EventEmitter } from "node:events";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { expect, it, vi } from "vitest";
import type { TrustedIpc } from "./TrustedIpc";

vi.mock("electron", () => ({
  BrowserWindow: class extends EventEmitter {
    private visible: boolean;
    private maximized = false;
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    });

    constructor(options: BrowserWindowConstructorOptions) {
      super();
      this.visible = options.show !== false;
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
    loadURL() {
      return Promise.resolve();
    }
  },
}));
vi.mock("./AppPaths", () => ({ themeIconPath: () => null }));
vi.mock("./Splash", () => ({ readSavedTheme: () => "dark" }));
vi.mock("./WindowState", () => ({
  loadWindowState: () => ({ width: 1280, height: 720, maximized: true }),
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
