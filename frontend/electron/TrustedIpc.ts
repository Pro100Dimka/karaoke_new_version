import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";

export interface IpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
}

export const createTrustedIpc = (getWindow: () => BrowserWindow | null, rendererUrl: string) => {
  const entry = new URL(rendererUrl);
  entry.hash = "";
  const isRendererUrl = (value: string): boolean => {
    try {
      const url = new URL(value);
      url.hash = "";
      return url.href === entry.href;
    } catch {
      return false;
    }
  };
  const handle: IpcRegistrar["handle"] = (channel, listener) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const window = getWindow();
      if (!window || window.isDestroyed() || event.sender !== window.webContents ||
          event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame ||
          !isRendererUrl(event.senderFrame.url)) {
        throw new Error("Untrusted IPC sender");
      }
      return listener(event, ...args);
    });
  };
  return { handle, isRendererUrl };
};
