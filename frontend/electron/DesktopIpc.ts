import { app, clipboard, dialog, shell, type BrowserWindow, type FileFilter } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { launchAsio4AllInstaller } from "./Asio4AllInstaller";
import { projectRoot, saveStorageRoot, themeIconPath } from "./AppPaths";
import { ipcChannels } from "./ipcChannels";
import { requireObject, requireString } from "./RequestValidation";
import { pickSceneClip } from "./SceneProtocol";
import { isThemeName, saveTheme } from "./Splash";
import type { TrustedIpc } from "./TrustedIpc";

interface DesktopIpcContext {
  trustedIpc: TrustedIpc;
  window: () => BrowserWindow | null;
  storageRoot: () => string;
  /** The renderer says when the first real screen (or an error screen) is ready to look at. */
  reveal: () => void;
  /** The renderer agreed to close (it asked about unsaved edits, a recording, a room, …). */
  confirmClose: () => void;
}

const audioFiles: FileFilter[] = [{ name: "Audio", extensions: ["mp3", "wav", "flac", "m4a", "ogg"] }];
const imageFiles: FileFilter[] = [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }];

const requireSafeExternalUrl = (value: unknown): string => {
  const url = new URL(requireString(value, "url"));
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new TypeError("Unsupported external URL protocol");
  return url.toString();
};

/** The files the user picked, or none when the dialog was cancelled or no window is open. */
const pickFiles = async (
  window: BrowserWindow | null,
  filters: FileFilter[],
  multiple: boolean,
): Promise<string[]> => {
  if (!window) return [];
  const result = await dialog.showOpenDialog(window, {
    properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
    filters,
  });
  return result.canceled ? [] : result.filePaths;
};

const registerWindowControls = ({ trustedIpc, window, reveal, confirmClose }: DesktopIpcContext) => {
  trustedIpc.handle(ipcChannels.minimize, () => window()?.minimize());
  trustedIpc.handle(ipcChannels.toggleMaximize, () => {
    const current = window();
    if (!current) return false;
    if (current.isMaximized()) current.unmaximize();
    else current.maximize();
    return current.isMaximized();
  });
  trustedIpc.handle(ipcChannels.close, () => window()?.close());
  trustedIpc.handle(ipcChannels.isMaximized, () => window()?.isMaximized() ?? false);
  trustedIpc.handle(ipcChannels.toggleFullscreen, () => {
    const current = window();
    if (!current) return false;
    current.setFullScreen(!current.isFullScreen());
    return current.isFullScreen();
  });
  trustedIpc.handle(ipcChannels.isFullscreen, () => window()?.isFullScreen() ?? false);
  // The taskbar icon follows the active theme, like the icon inside the application.
  trustedIpc.handle(ipcChannels.setAppIcon, (_event, theme: unknown) => {
    const icon = typeof theme === "string" ? themeIconPath(theme) : null;
    if (!icon || !isThemeName(theme)) return;
    saveTheme(theme);
    window()?.setIcon(icon);
  });
  trustedIpc.handle(ipcChannels.appReady, () => reveal());
  trustedIpc.handle(ipcChannels.relaunchApp, () => {
    app.relaunch();
    app.exit(0);
  });
  trustedIpc.handle(ipcChannels.confirmClose, () => confirmClose());
};

const registerFileDialogs = ({ trustedIpc, window, storageRoot }: DesktopIpcContext) => {
  trustedIpc.handle(ipcChannels.pickAudioFile, async () =>
    (await pickFiles(window(), audioFiles, false))[0] ?? null,
  );
  trustedIpc.handle(ipcChannels.pickAudioFiles, () => pickFiles(window(), audioFiles, true));
  trustedIpc.handle(ipcChannels.pickImageFile, async () =>
    (await pickFiles(window(), imageFiles, false))[0] ?? null,
  );
  trustedIpc.handle(ipcChannels.pickStorageFolder, async (_event, current: unknown) => {
    const owner = window();
    if (!owner) return null;
    const result = await dialog.showOpenDialog(owner, {
      defaultPath: typeof current === "string" && path.isAbsolute(current) ? current : storageRoot(),
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  trustedIpc.handle(ipcChannels.saveTextFile, async (_event, raw: unknown) => {
    const owner = window();
    if (!owner || !raw || typeof raw !== "object") return false;
    const request = requireObject(raw, "text file");
    const defaultName = path.basename(requireString(request.defaultName, "defaultName"));
    const content = requireString(request.content, "content");
    const result = await dialog.showSaveDialog(owner, {
      defaultPath: defaultName,
      filters: [{ name: "Text", extensions: ["txt", "json"] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, content, "utf8");
    return true;
  });
};

const registerFilesAndShell = ({ trustedIpc, storageRoot }: DesktopIpcContext) => {
  trustedIpc.handle(ipcChannels.getStorageRoot, () => storageRoot());
  trustedIpc.handle(ipcChannels.setStorageRoot, (_event, raw: unknown) => {
    const folder = requireString(raw, "path").trim();
    if (!path.isAbsolute(folder)) throw new TypeError("Storage path must be absolute");
    saveStorageRoot(folder);
  });
  trustedIpc.handle(ipcChannels.statFile, (_event, value: unknown) => {
    const filePath = requireString(value, "path");
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error("Not a file");
    return {
      name: path.basename(filePath),
      extension: path.extname(filePath).slice(1).toLowerCase(),
      sizeBytes: stats.size,
    };
  });
  trustedIpc.handle(ipcChannels.reveal, (_event, targetPath: unknown) => {
    shell.showItemInFolder(requireString(targetPath, "path"));
  });
  trustedIpc.handle(ipcChannels.openExternal, async (_event, value: unknown) => {
    await shell.openExternal(requireSafeExternalUrl(value));
  });
  trustedIpc.handle(ipcChannels.copyText, (_event, value: unknown) => {
    clipboard.writeText(requireString(value, "text"));
  });
  trustedIpc.handle(ipcChannels.sceneVideoUrl, () => pickSceneClip(projectRoot()));
  trustedIpc.handle(ipcChannels.openMicrophonePrivacy, async () => {
    await shell.openExternal("ms-settings:privacy-microphone");
  });
  trustedIpc.handle(ipcChannels.installAsio4All, async () => {
    if (process.platform !== "win32") throw new Error("ASIO4ALL is available only on Windows");
    await launchAsio4AllInstaller(path.join(app.getPath("temp"), "ad-voice-asio4all"), (target) =>
      shell.openPath(target),
    );
  });
};

/** The window, dialog, file and shell services the renderer may ask the desktop for. */
export const registerDesktopIpc = (context: DesktopIpcContext): void => {
  registerWindowControls(context);
  registerFileDialogs(context);
  registerFilesAndShell(context);
};
