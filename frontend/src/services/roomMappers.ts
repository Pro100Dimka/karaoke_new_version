import type { ParticipantDto, RoomStateDto } from "../contracts/models";

export interface BackendRoomParticipant {
  participantId: string;
  displayName: string;
  role: string;
  connectionState: string;
  readinessState: string;
}

export interface BackendRoom {
  roomId: string;
  hostId: string;
  songId: string | null;
  revision: number | null;
  participants: BackendRoomParticipant[];
  playbackState: string;
  playbackStartedAt: string | null;
  playbackPositionSeconds: number;
  serverNow: string;
}

/** Stable across restarts so a reload rejoins as the same participant instead of a new one. */
export const participantId = ((): string => {
  const key = "adVoice.participantId";
  try {
    const stored = window.localStorage.getItem(key);
    if (stored) return stored;
    const created = crypto.randomUUID();
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
})();

export const readinessOf = (value: string): ParticipantDto["readiness"] => {
  const known = {
    missingsong: "missing",
    downloading: "downloading",
    importing: "verifying",
    preparing: "audio",
    ready: "ready",
    failed: "failed",
    disconnected: "disconnected"
  } as const;
  return (known as Record<string, ParticipantDto["readiness"]>)[value.toLowerCase()] ?? "preparing";
};

export const mapRoom = (room: BackendRoom): RoomStateDto => ({
  code: room.roomId,
  hostId: room.hostId,
  songId: room.songId ?? undefined,
  revision: room.revision ?? undefined,
  role: room.hostId === participantId ? "host" : "participant",
  participants: room.participants.map(participant => ({
    id: participant.participantId,
    name: participant.displayName,
    role: participant.role.toLowerCase() === "host" ? "host" : "participant",
    self: participant.participantId === participantId,
    connected: participant.connectionState.toLowerCase() === "connected",
    muted: false,
    speakingLevel: 0,
    volume: 1,
    readiness: readinessOf(participant.readinessState)
  })),
  playbackLocked: room.playbackState.toLowerCase() === "playing",
  playbackState: room.playbackState.toLowerCase() as RoomStateDto["playbackState"],
  playbackStartedAt: room.playbackStartedAt ?? undefined,
  playbackPositionSeconds: room.playbackPositionSeconds,
  serverNow: room.serverNow
});
