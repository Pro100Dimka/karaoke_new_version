import type { RoomClient } from "../contracts/clients";
import type { AppError } from "../contracts/models";
import { BackendRoom, mapRoom, participantId } from "./roomMappers";

const bridge = (): DesktopApi => {
  if (!window.desktop) throw new Error("Desktop bridge is unavailable");
  return window.desktop;
};

const roomPath = (code: string): string => encodeURIComponent(code.trim().toLowerCase());

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
    const room = await request<BackendRoom>("POST", `/rooms/${roomPath(code)}/join`, {
      participantId,
      displayName
    });
    return mapRoom(room);
  },

  async getRoom(code) {
    return mapRoom(await request<BackendRoom>("GET", `/rooms/${roomPath(code)}`));
  },

  async leaveRoom(code) {
    await request("POST", `/rooms/${roomPath(code)}/leave`, { participantId });
  },

  async selectRoomSong(code, songId, revision) {
    return mapRoom(
      await request<BackendRoom>("POST", `/rooms/${roomPath(code)}/song`, { participantId, songId, revision })
    );
  },

  async clearRoomSong(code) {
    return mapRoom(
      await request<BackendRoom>("POST", `/rooms/${roomPath(code)}/song/clear`, { participantId })
    );
  },

  async setRoomReadiness(code, readiness) {
    return mapRoom(
      await request<BackendRoom>("POST", `/rooms/${roomPath(code)}/readiness`, { participantId, readiness })
    );
  },

  async roomControl(code, command, positionSeconds) {
    return mapRoom(await request<BackendRoom>("POST", `/rooms/${roomPath(code)}/control`, {
      participantId,
      command,
      positionSeconds
    }));
  },

  async updateSharedState(code, state) {
    const path = `/rooms/${roomPath(code)}/shared-state`;
    try {
      return mapRoom(await request<BackendRoom>("POST", path, { participantId, ...state }));
    } catch (error) {
      // Existing Oracle deployments used the schema below. Keep radio/search/filter usable
      // during a rolling server upgrade; a current server accepts the authoritative audio fields.
      if (!error || typeof error !== "object" || (error as AppError).code !== "Http422") throw error;
      const { playbackRate: _playbackRate, keyShift: _keyShift, ...legacyState } = state;
      return mapRoom(await request<BackendRoom>("POST", path, { participantId, ...legacyState }));
    }
  },

  async startSyncCheck(code) {
    return mapRoom(await request<BackendRoom>(
      "POST",
      `/rooms/${roomPath(code)}/sync-check`,
      { participantId }
    ));
  },

  async setCollaborativeControl(code, enabled) {
    return mapRoom(await request<BackendRoom>(
      "POST",
      `/rooms/${roomPath(code)}/collaborative-control`,
      { participantId, enabled }
    ));
  },

  async publishLibrary(code, songs) {
    return mapRoom(await request<BackendRoom>("POST", `/rooms/${roomPath(code)}/library`, {
      participantId,
      songs: songs
        .filter(song => song.status === "ready")
        .map(song => ({
          songId: song.id,
          revision: song.activeRevision,
          title: song.title,
          artist: song.artist,
          album: song.album,
          genre: song.genre,
          durationSeconds: song.durationSeconds
        }))
    }));
  }
};
