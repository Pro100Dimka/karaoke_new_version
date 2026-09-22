import type { RoomClient } from "../contracts/clients";
import type { AppError } from "../contracts/models";
import { BackendRoom, mapRoom, participantId } from "./roomMappers";

const bridge = (): DesktopApi => {
  if (!window.desktop) throw new Error("Desktop bridge is unavailable");
  return window.desktop;
};

const request = async <T>(
  method: PythonBridgeRequest["method"],
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<T> => {
  const response = await bridge().roomRequest({ method, path, body, headers });
  if (!response.ok) {
    const raw = response.body && typeof response.body === "object"
      ? response.body as Record<string, unknown>
      : {};
    const error: AppError = {
      code: typeof raw.code === "string" ? raw.code : `Http${response.status}`,
      message: typeof raw.message === "string" ? raw.message : "Room server request failed",
      details: raw.details === undefined ? undefined : JSON.stringify(raw.details),
      source: "python",
      correlationId: typeof raw.requestId === "string" ? raw.requestId : undefined
    };
    throw error;
  }
  return response.body as T;
};

export const roomClient: RoomClient = {
  async createRoom(displayName) {
    const room = await request<BackendRoom>("POST", "/rooms", {
      participantId,
      displayName,
      disconnectPolicy: "Transfer"
    });
    return mapRoom(room);
  },

  async joinRoom(code, displayName) {
    const room = await request<BackendRoom>("POST", `/rooms/${encodeURIComponent(code)}/join`, {
      participantId,
      displayName
    });
    return mapRoom(room);
  },

  async getRoom(code) {
    return mapRoom(await request<BackendRoom>("GET", `/rooms/${encodeURIComponent(code)}`));
  },

  async leaveRoom(code) {
    await request("POST", `/rooms/${encodeURIComponent(code)}/leave`, { participantId });
  },

  async selectRoomSong(code, songId, revision) {
    return mapRoom(
      await request<BackendRoom>("POST", `/rooms/${encodeURIComponent(code)}/song`, { participantId, songId, revision })
    );
  },

  async setRoomReadiness(code, readiness) {
    return mapRoom(
      await request<BackendRoom>("POST", `/rooms/${encodeURIComponent(code)}/readiness`, { participantId, readiness })
    );
  },

  async roomControl(code, command) {
    await request("POST", `/rooms/${encodeURIComponent(code)}/control`, { participantId, command });
  }
};
