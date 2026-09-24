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

const requestRoom = async (
  method: PythonBridgeRequest["method"],
  path: string,
  body?: unknown,
  headers?: Record<string, string>
) => {
  const startedAtMilliseconds = Date.now();
  const room = await request<BackendRoom>(method, path, body, headers);
  return mapRoom(room, {
    startedAtMilliseconds,
    receivedAtMilliseconds: Date.now()
  });
};

export const roomClient: RoomClient = {
  async createRoom(displayName) {
    return requestRoom("POST", "/rooms", {
      participantId,
      displayName,
      disconnectPolicy: "Transfer"
    });
  },

  async joinRoom(code, displayName) {
    return requestRoom("POST", `/rooms/${roomPath(code)}/join`, {
      participantId,
      displayName
    });
  },

  async getRoom(code) {
    return requestRoom("GET", `/rooms/${roomPath(code)}`);
  },

  watchRoom(code, onRoom, onError) {
    let active = true;
    let version = 0;
    void (async () => {
      while (active) {
        try {
          const change = await request<{ version: number; room: BackendRoom | null }>(
            "GET",
            `/rooms/${roomPath(code)}/changes?participantId=${encodeURIComponent(participantId)}&after=${version}`,
          );
          if (!active) return;
          if (change.room === null) {
            onError({ code: "RoomNotFound", message: "Room was closed", source: "python" });
            return;
          }
          if (change.version > version) {
            version = change.version;
            // This request intentionally waits on the server. Its wall time is not a
            // round trip measurement and must never influence the clock offset.
            onRoom(mapRoom(change.room));
          }
        } catch (error) {
          if (!active) return;
          onError(error);
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
      }
    })();
    return () => { active = false; };
  },

  async leaveRoom(code) {
    await request("POST", `/rooms/${roomPath(code)}/leave`, { participantId });
  },

  async transferHost(code, targetParticipantId) {
    return requestRoom("POST", `/rooms/${roomPath(code)}/host`, {
      participantId,
      targetParticipantId
    });
  },

  async removeParticipant(code, targetParticipantId) {
    return requestRoom(
      "POST",
      `/rooms/${roomPath(code)}/participants/${encodeURIComponent(targetParticipantId)}/remove`,
      { participantId }
    );
  },

  async closeRoom(code) {
    await request("POST", `/rooms/${roomPath(code)}/close`, { participantId });
  },

  async selectRoomSong(code, songId, revision) {
    return requestRoom("POST", `/rooms/${roomPath(code)}/song`, { participantId, songId, revision });
  },

  async clearRoomSong(code) {
    return requestRoom("POST", `/rooms/${roomPath(code)}/song/clear`, { participantId });
  },

  async setRoomReadiness(code, readiness, progress) {
    return requestRoom("POST", `/rooms/${roomPath(code)}/readiness`, { participantId, readiness, progress });
  },

  async roomControl(code, command, positionSeconds) {
    return requestRoom("POST", `/rooms/${roomPath(code)}/control`, {
      participantId,
      command,
      positionSeconds
    });
  },

  async updateSharedState(code, state) {
    const path = `/rooms/${roomPath(code)}/shared-state`;
    try {
      return await requestRoom("POST", path, { participantId, ...state });
    } catch (error) {
      // Existing Oracle deployments used the schema below. Keep radio/search/filter usable
      // during a rolling server upgrade; a current server accepts the authoritative audio fields.
      if (!error || typeof error !== "object" || (error as AppError).code !== "Http422") throw error;
      const { playbackRate: _playbackRate, keyShift: _keyShift, ...legacyState } = state;
      return requestRoom("POST", path, { participantId, ...legacyState });
    }
  },

  async startSyncCheck(code) {
    return requestRoom("POST", `/rooms/${roomPath(code)}/sync-check`, { participantId });
  },

  async setCollaborativeControl(code, enabled) {
    return requestRoom("POST", `/rooms/${roomPath(code)}/collaborative-control`, {
      participantId,
      enabled
    });
  },

  async publishLibrary(code, songs) {
    return requestRoom("POST", `/rooms/${roomPath(code)}/library`, {
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
    });
  }
};
