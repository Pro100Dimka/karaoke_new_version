import { execFile } from "node:child_process";
import type { App } from "electron";

/** The installed app's id; the installer gives its Start menu shortcut the same one. */
export const installedAppUserModelId = "ADVoice.App";
const installedName = "AD Voice";
const developmentName = "AD Voice Dev";

/**
 * The Windows identity of this run: the installed app, the development checkout, or another profile
 * (start-multy.bat) each get their own, so their notifications and taskbar groups never mix.
 */
export const notificationIdentity = (
  applicationName: string,
): { id: string; displayName: string } => {
  if (applicationName === installedName) return { id: installedAppUserModelId, displayName: "A&D Voice" };
  if (applicationName === developmentName) return { id: `${installedAppUserModelId}.Dev`, displayName: "A&D Voice" };
  const profile = applicationName.replace(/^AD Voice\s*/i, "").trim() || applicationName;
  const suffix = profile.replace(/[^A-Za-z0-9]+/g, "") || "Profile";
  return { id: `${installedAppUserModelId}.${suffix}`, displayName: `A&D Voice · ${profile}` };
};

/** The registry values Windows reads a sender's name and icon from for apps without a shortcut. */
export const notificationRegistryCommands = (
  id: string,
  displayName: string,
  iconPath: string | null,
): string[][] => {
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${id}`;
  return [
    ["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", displayName, "/f"],
    ...(iconPath ? [["add", key, "/v", "IconUri", "/t", "REG_SZ", "/d", iconPath, "/f"]] : []),
  ];
};

/**
 * Names the app in Windows notifications ("A&D Voice" instead of "Electron"): the process takes its
 * own AppUserModelID and registers that id's display name and icon for the current user. Runs before
 * any window or notification; the registry write is fire-and-forget and never delays start-up.
 */
export const configureNotificationIdentity = (app: App, iconPath: string | null): void => {
  if (process.platform !== "win32") return;
  const { id, displayName } = notificationIdentity(app.getName());
  app.setAppUserModelId(id);
  for (const args of notificationRegistryCommands(id, displayName, iconPath))
    execFile("reg", args, { windowsHide: true }, () => undefined);
};
