import type { BrowserWindow } from "electron";
import { ipcChannels } from "./ipcChannels";
import { createSocialSocket, type SocialPresence } from "./SocialSocket";
import { acceptRoomVoiceLevels } from "./RoomServerTransport";
import { requireObject } from "./RequestValidation";
import type { IpcRegistrar } from "./TrustedIpc";

const optionalId = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;

const requirePresence = (raw: unknown): SocialPresence => {
  const value = requireObject(raw, "Presence");
  if (typeof value.displayName !== "string") throw new TypeError("displayName must be a string");
  return {
    displayName: value.displayName.slice(0, 200),
    participantId: optionalId(value.participantId),
    roomId: optionalId(value.roomId),
  };
};

/**
 * Friends for the renderer: the socket lives here, beside the device secret, and the renderer
 * receives each pushed inbox as an event (and the latest one when it asks, e.g. after a reload).
 */
export const registerSocialChannel = (
  apiBase: string,
  getWindow: () => BrowserWindow | null,
  ipc: IpcRegistrar,
) => {
  let latest: unknown = { type: "offline" };
  const socket = createSocialSocket(`${apiBase.replace(/^http/, "ws")}/social/socket`, message => {
    acceptRoomVoiceLevels(message);
    const isInbox = message && typeof message === "object" && "notices" in message;
    const isOffline = message && typeof message === "object" && (message as { type?: unknown }).type === "offline";
    if (!isInbox && !isOffline) return;
    // Answers are told once: a renderer that reloads gets the inbox without the ones already shown.
    latest = isInbox ? { ...message, notices: [] } : message;
    getWindow()?.webContents.send(ipcChannels.socialInbox, message);
  });
  ipc.handle(ipcChannels.socialPresence, (_event, raw) => socket.setPresence(requirePresence(raw)));
  ipc.handle(ipcChannels.socialLatest, () => latest);
  return socket;
};
