import { EventEmitter } from 'node:events';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { expect, it, vi } from 'vitest';
import type { TrustedIpc } from './TrustedIpc';

vi.mock('electron', () => ({
  BrowserWindow: class extends EventEmitter {
    private visible: boolean;
    private destroyed = false;
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
      (
        this.constructor as { lastOptions?: BrowserWindowConstructorOptions }
      ).lastOptions = options;
    }

    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    isFocused() {
      return true;
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
      this.emit('show');
    }
    close() {
      let prevented = false;
      this.emit('close', {
        preventDefault: () => {
          prevented = true;
        },
      });
      if (!prevented) {
        this.destroyed = true;
        this.emit('closed');
      }
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
vi.mock('./AppPaths', () => ({ themeIconPath: () => null }));
vi.mock('./Splash', () => ({ readSavedTheme: () => 'dark' }));
const savedState = vi.hoisted(() => ({ maximized: true, fullscreen: false }));
vi.mock('./WindowState', () => ({
  loadWindowState: () => ({ width: 1280, height: 720, ...savedState }),
  saveWindowState: vi.fn(),
  publishWindowState: vi.fn(),
}));
vi.mock('./PanelWindows', () => ({
  panelWindowOpenHandler: () => vi.fn(),
  securePanelWindow: vi.fn(),
}));
vi.mock('./AppVisibility', () => ({
  watchAppVisibility: () => ({ republish: vi.fn(), addPanel: vi.fn() }),
}));

it('keeps a saved maximized main window hidden behind the loader until reveal', async () => {
  const { createMainWindow } = await import('./MainWindow');
  let mainWindow!: BrowserWindow;
  let loaderVisible = true;
  const reveal = () => {
    mainWindow.show();
    loaderVisible = false;
  };
  mainWindow = createMainWindow({
    rendererUrl: 'file:///app/index.html',
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: 'participant',
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

it.each([true, false])(
  'completes one close request only when the renderer approves: %s',
  async (allowed) => {
    const { createMainWindow } = await import('./MainWindow');
    const { ipcChannels } = await import('./ipcChannels');
    let confirmed = false;
    const window = createMainWindow({
      rendererUrl: 'file:///app/index.html',
      trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
      roomParticipant: 'participant',
      closeConfirmed: () => confirmed,
      reveal: vi.fn(),
    });
    vi.mocked(window.webContents.send).mockImplementation((channel) => {
      if (channel !== ipcChannels.closeRequested) return;
      void Promise.resolve().then(() => {
        confirmed = allowed;
        if (allowed) window.close();
      });
    });
    window.close();
    expect(window.isDestroyed()).toBe(false);
    await Promise.resolve();
    expect(window.isDestroyed()).toBe(allowed);
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(
      ipcChannels.closeRequested,
    );
  },
);

it('reopens full screen behind the loader when the window was closed full screen', async () => {
  savedState.fullscreen = true;
  try {
    const { createMainWindow } = await import('./MainWindow');
    const mainWindow = createMainWindow({
      rendererUrl: 'file:///app/index.html',
      trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
      roomParticipant: 'participant',
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

it('turns off spell checking: no underlines and no dictionary downloads', async () => {
  const { createMainWindow } = await import('./MainWindow');
  const { BrowserWindow } = await import('electron');
  createMainWindow({
    rendererUrl: 'file:///app/index.html',
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: 'participant',
    closeConfirmed: () => false,
    reveal: vi.fn(),
  });
  expect(
    (
      BrowserWindow as unknown as {
        lastOptions: BrowserWindowConstructorOptions;
      }
    ).lastOptions.webPreferences?.spellcheck,
  ).toBe(false);
});

it('publishes the explicit fullscreen transition even when Windows reports its previous flag during the event', async () => {
  const { createMainWindow } = await import('./MainWindow');
  const { publishWindowState } = await import('./WindowState');
  const window = createMainWindow({
    rendererUrl: 'file:///app/index.html',
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: 'participant',
    closeConfirmed: () => false,
    reveal: vi.fn(),
  });
  expect(window.isFullScreen()).toBe(false);
  window.emit('enter-full-screen');
  expect(publishWindowState).toHaveBeenLastCalledWith(window, {
    fullscreen: true,
  });
  window.setFullScreen(true);
  window.emit('leave-full-screen');
  expect(publishWindowState).toHaveBeenLastCalledWith(window, {
    fullscreen: false,
  });
});

it('forwards renderer and detached panel console errors to the app log', async () => {
  const { createMainWindow } = await import('./MainWindow');
  const log = vi.fn();
  const window = createMainWindow({
    rendererUrl: 'file:///app/index.html',
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: 'participant',
    closeConfirmed: () => false,
    reveal: vi.fn(),
    log,
  });
  window.webContents.emit('console-message', {
    level: 'error',
    message: 'renderer failed',
  });
  const panel = { webContents: new EventEmitter() } as unknown as BrowserWindow;
  window.webContents.emit('did-create-window', panel);
  panel.webContents.emit('console-message', {
    level: 'warning',
    message: 'panel lag',
  });
  expect(log.mock.calls).toEqual([
    ['renderer', 'error', 'renderer failed'],
    ['renderer', 'warning', 'panel lag'],
  ]);
});

it('reports renderer hangs and recovery in the central log', async () => {
  const { createMainWindow } = await import('./MainWindow');
  const log = vi.fn();
  const window = createMainWindow({
    rendererUrl: 'file:///app/index.html',
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: 'participant',
    closeConfirmed: () => false,
    reveal: vi.fn(),
    log,
  });
  window.emit('unresponsive');
  window.emit('responsive');
  expect(log.mock.calls).toEqual([
    ['renderer', 'warning', 'Renderer unresponsive'],
    ['renderer', 'info', 'Renderer responsive'],
  ]);
});

it('records a failed renderer load before revealing the error window', async () => {
  const { createMainWindow } = await import('./MainWindow');
  const log = vi.fn();
  const reveal = vi.fn();
  const window = createMainWindow({
    rendererUrl: 'file:///app/index.html',
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: 'participant',
    closeConfirmed: () => false,
    reveal,
    log,
  });
  window.webContents.emit('did-fail-load', {}, -6, 'File not found');
  expect(log).toHaveBeenCalledWith(
    'renderer',
    'error',
    'Renderer failed to load (-6): File not found',
  );
  expect(reveal).toHaveBeenCalledOnce();
});

it('allows a failed main document to close, but preserves guards for subframes and after recovery', async () => {
  const { createMainWindow } = await import('./MainWindow');
  const window = createMainWindow({
    rendererUrl: 'file:///app/index.html',
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: 'participant',
    closeConfirmed: () => false,
    reveal: vi.fn(),
  });
  const close = { preventDefault: vi.fn() };
  window.webContents.emit(
    'did-fail-load',
    {},
    -6,
    'File not found',
    'file:///app/frame.html',
    false,
  );
  window.emit('close', close);
  expect(close.preventDefault).toHaveBeenCalledOnce();
  close.preventDefault.mockClear();

  window.webContents.emit(
    'did-fail-load',
    {},
    -6,
    'File not found',
    'file:///app/index.html',
    true,
  );
  window.emit('close', close);
  expect(close.preventDefault).not.toHaveBeenCalled();

  window.webContents.emit('did-finish-load');
  window.emit('close', close);
  expect(close.preventDefault).toHaveBeenCalledOnce();
});

it('allows native close after preload failure even when the document loads and responds', async () => {
  const { createMainWindow } = await import('./MainWindow');
  const log = vi.fn();
  const window = createMainWindow({
    rendererUrl: 'file:///app/index.html',
    trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
    roomParticipant: 'participant',
    closeConfirmed: () => false,
    reveal: vi.fn(),
    log,
  });
  window.webContents.emit(
    'preload-error',
    {},
    '/app/preload.js',
    new Error('Missing preload dependency'),
  );
  window.webContents.emit('did-finish-load');
  window.emit('responsive');
  window.close();

  expect(window.isDestroyed()).toBe(true);
  expect(window.webContents.send).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(
    'renderer',
    'error',
    'Renderer preload failed (/app/preload.js): Missing preload dependency',
  );
});

it.each([
  ['subframe', false, false],
  ['same document', true, true],
  ['pending main document', true, false],
] as const)(
  'keeps native close available after preload failure during a %s navigation',
  async (_kind, isMainFrame, isSameDocument) => {
    const { createMainWindow } = await import('./MainWindow');
    const window = createMainWindow({
      rendererUrl: 'file:///app/index.html',
      trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
      roomParticipant: 'participant',
      closeConfirmed: () => false,
      reveal: vi.fn(),
    });
    window.webContents.emit(
      'preload-error',
      {},
      '/app/preload.js',
      new Error('Missing preload dependency'),
    );
    window.webContents.emit('did-start-navigation', {
      isMainFrame,
      isSameDocument,
    });
    window.emit('responsive');
    window.close();

    expect(window.isDestroyed()).toBe(true);
  },
);

it.each([false, true])(
  'restores close guards only after a new main document loads with working preload: failed=%s',
  async (preloadFailsAgain) => {
    const { createMainWindow } = await import('./MainWindow');
    const window = createMainWindow({
      rendererUrl: 'file:///app/index.html',
      trustedIpc: { isRendererUrl: () => true } as unknown as TrustedIpc,
      roomParticipant: 'participant',
      closeConfirmed: () => false,
      reveal: vi.fn(),
    });
    const failPreload = () =>
      window.webContents.emit(
        'preload-error',
        {},
        '/app/preload.js',
        new Error('Missing preload dependency'),
      );
    failPreload();
    window.webContents.emit('did-finish-load');
    window.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    if (preloadFailsAgain) failPreload();
    window.webContents.emit('did-finish-load');
    window.close();

    expect(window.isDestroyed()).toBe(preloadFailsAgain);
    expect(window.webContents.send).toHaveBeenCalledTimes(
      preloadFailsAgain ? 0 : 1,
    );
  },
);
