import { app, globalShortcut, powerMonitor, screen } from "electron";
import * as path from "node:path";
import { commandsFromArguments, linkScheme, taskArguments, type DesktopShell, type ShellStatus } from "./DesktopShell";
import { shellText } from "./ShellText";

/**
 * Turns the microphone on and off while in a room, even when another window has focus. Not Ctrl+Shift+M
 * (Discord's own mute) and not Ctrl+Alt+M (already taken by other software on a test machine).
 */
export const muteShortcut = "CommandOrControl+Alt+Shift+M";

/** How the running app is started again: the packaged exe, or electron.exe with the app folder. */
const relaunchArguments = (extra: readonly string[]): { program: string; args: string[] } =>
  process.defaultApp
    ? { program: process.execPath, args: [path.resolve(process.argv[1] ?? "."), ...extra] }
    : { program: process.execPath, args: [...extra] };

const quote = (value: string) => (/\s/.test(value) ? `"${value}"` : value);

/** The jump list (right click on the taskbar icon) in the app's language. */
export const jumpListTasks = (language: ShellStatus["language"]) =>
  (
    [
      [taskArguments.addSong, "addSong"],
      [taskArguments.openRoom, "openRoom"],
    ] as const
  ).map(([argument, key]) => {
    const { program, args } = relaunchArguments([argument]);
    return {
      program,
      arguments: args.map(quote).join(" "),
      title: shellText(language, key),
      description: shellText(language, key),
      iconPath: process.execPath,
      iconIndex: 0,
    };
  });

/**
 * Everything that reaches the app from Windows: the launch's own arguments and a second launch's
 * (invitation links, jump-list tasks, files opened with the app), the jump list itself, the mute
 * hotkey while in a room, and switches between battery and mains power.
 */
export const startDesktopLaunch = (shell: DesktopShell, notify: (title: string, body: string) => void) => {
  // The installer registers advoice:// for the installed app; a development checkout leaves the
  // registry alone so it never takes links away from the installed one.
  if (app.isPackaged && !app.isDefaultProtocolClient(linkScheme)) app.setAsDefaultProtocolClient(linkScheme);
  for (const command of commandsFromArguments(process.argv.slice(1))) shell.send(command);

  let language: ShellStatus["language"] | null = null;
  let muteRegistered = false;
  const applyStatus = (status: ShellStatus) => {
    if (status.language !== language) {
      language = status.language;
      app.setUserTasks(jumpListTasks(status.language));
    }
    const inRoom = Boolean(status.room);
    if (inRoom && !muteRegistered) {
      muteRegistered = globalShortcut.register(muteShortcut, () => {
        const before = shell.status().microphoneMuted;
        shell.send({ type: "toggleMicrophone" });
        // While another window is in front, a notification confirms the switch.
        notify("A&D Voice", shellText(shell.status().language, before ? "microphoneOn" : "microphoneOff"));
      });
      if (!muteRegistered) console.warn(`Mute hotkey ${muteShortcut} is taken by another program`);
    } else if (!inRoom && muteRegistered) {
      globalShortcut.unregister(muteShortcut);
      muteRegistered = false;
    }
  };
  applyStatus(shell.status());
  shell.onStatus((status) => applyStatus(status));

  const displays = () => shell.send({ type: "displays", count: screen.getAllDisplays().length });
  displays();
  screen.on("display-added", displays);
  screen.on("display-removed", displays);

  const power = () => shell.send({ type: "power", onBattery: powerMonitor.isOnBatteryPower() });
  power();
  powerMonitor.on("on-battery", power);
  powerMonitor.on("on-ac", power);

  return {
    /** A second launch handed its arguments over: carry them out here. */
    secondLaunch(argv: readonly string[]): void {
      for (const command of commandsFromArguments(argv.slice(1))) shell.send(command);
    },
    stop(): void {
      if (muteRegistered) globalShortcut.unregister(muteShortcut);
      muteRegistered = false;
    },
  };
};
