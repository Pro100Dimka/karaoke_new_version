import { Menu, Tray, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { DesktopShell, ShellStatus } from "./DesktopShell";
import { shellText } from "./ShellText";

interface TrayOptions {
  window: () => BrowserWindow | null;
  shell: DesktopShell;
  iconPath: () => string | null;
  notify: (title: string, body: string) => void;
  /** Starts the app's normal exit (with its unsaved-work questions). */
  quit: () => void;
  /** True once the app is quitting: closing then really closes. */
  quitting: () => boolean;
}

/** The tray's menu for the current status: open, radio on/off, next station, quit. */
/** "Artist — Title" of what the radio plays, when the station tells. */
export const radioTrackText = (status: ShellStatus): string | undefined => {
  const track = status.radio.track;
  return track ? [track.artist, track.title].filter(Boolean).join(" — ") : undefined;
};

export const trayMenuTemplate = (
  status: ShellStatus,
  actions: { open(): void; quit(): void; send: DesktopShell["send"] },
): MenuItemConstructorOptions[] => {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(status.language, key);
  const track = status.radio.enabled ? radioTrackText(status) : undefined;
  return [
    { label: t("openApp"), click: actions.open },
    { type: "separator" },
    // What plays now, as a line of its own (it cannot be clicked).
    ...(track ? [{ label: `♪ ${track}`.slice(0, 120), enabled: false }] : []),
    {
      label: status.radio.station ? `${t("radio")} · ${status.radio.station}` : t("radio"),
      type: "checkbox",
      checked: status.radio.enabled,
      enabled: status.radio.available,
      click: () => actions.send({ type: "toggleRadio" }),
    },
    {
      label: t("nextStation"),
      enabled: status.radio.available && status.radio.enabled,
      click: () => actions.send({ type: "nextStation" }),
    },
    { type: "separator" },
    { label: t("quit"), click: actions.quit },
  ];
};

/**
 * The radio as a background player. While it plays in the Library, closing the window hides it to
 * the notification area instead of quitting; the tray icon reopens it, switches the radio and
 * quits. The icon exists only while the radio plays or the window is hidden there.
 */
export const createTrayRadio = ({ window, shell, iconPath, notify, quit, quitting }: TrayOptions) => {
  let tray: Tray | null = null;
  let hiddenToTray = false;
  let toldOnce = false;

  const open = () => {
    const current = window();
    if (!current || current.isDestroyed()) return;
    hiddenToTray = false;
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
    sync(shell.status());
  };

  const sync = (status: ShellStatus) => {
    const wanted = hiddenToTray || (status.radio.available && status.radio.enabled);
    if (!wanted) {
      tray?.destroy();
      tray = null;
      return;
    }
    if (!tray) {
      const icon = iconPath();
      if (!icon) return;
      try {
        tray = new Tray(icon);
      } catch {
        // An unreadable icon only costs the tray, never the rest of the desktop integration.
        return;
      }
      tray.on("click", open);
    }
    const playing = status.radio.enabled ? (radioTrackText(status) ?? status.radio.station) : undefined;
    // Windows cuts tray tooltips at 127 characters.
    tray.setToolTip((playing ? `A&D Voice · ${playing}` : "A&D Voice").slice(0, 127));
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(status, { open, quit, send: (command) => shell.send(command) })));
  };

  shell.onStatus((status) => sync(status));

  return {
    /**
     * Called when the main window is about to close. Returns true when it was hidden to the tray
     * instead: the radio is playing in the Library and the app is not quitting.
     */
    closeToTray(): boolean {
      const status = shell.status();
      const current = window();
      if (quitting() || !current || current.isDestroyed()) return false;
      if (!(status.screen === "library" && status.radio.available && status.radio.enabled)) return false;
      hiddenToTray = true;
      current.hide();
      sync(status);
      if (!toldOnce) {
        toldOnce = true;
        notify("A&D Voice", shellText(status.language, "trayStillPlaying"));
      }
      return true;
    },
    destroy(): void {
      tray?.destroy();
      tray = null;
    },
  };
};
