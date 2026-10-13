import { Notification, type BrowserWindow } from "electron";
import type { DesktopShell } from "./DesktopShell";
import { ipcChannels } from "./ipcChannels";
import type { TrustedIpc } from "./TrustedIpc";

/**
 * Windows notifications for things that happen while the app is in the background (a song is
 * processed, a friend comes online). They are skipped while the app is the window in front, where
 * the interface shows its own messages; a click brings the app forward.
 */
export const createShellNotifier = (window: () => BrowserWindow | null, icon?: string) =>
  (title: string, body: string): void => {
    const current = window();
    if (current && !current.isDestroyed() && current.isVisible() && current.isFocused()) return;
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: title.slice(0, 120), body: body.slice(0, 300), icon, silent: false });
    notification.on("click", () => {
      const target = window();
      if (!target || target.isDestroyed()) return;
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
    });
    notification.show();
  };

/** The interface's side of the desktop shell: status reports, its command subscription, notifications. */
export const registerShellIpc = (
  trustedIpc: TrustedIpc,
  shell: DesktopShell,
  window: () => BrowserWindow | null,
  notify: (title: string, body: string) => void,
): void => {
  trustedIpc.handle(ipcChannels.shellStatus, (_event, status: unknown) => shell.report(status));
  trustedIpc.handle(ipcChannels.shellReady, (_event, ready: unknown) => {
    if (ready !== true) return shell.disconnect();
    shell.connect((command) => {
      const current = window();
      if (current && !current.isDestroyed()) current.webContents.send(ipcChannels.shellCommand, command);
    });
  });
  trustedIpc.handle(ipcChannels.notify, (_event, value: unknown) => {
    const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    if (typeof raw.title === "string" && typeof raw.body === "string") notify(raw.title, raw.body);
  });
};
