import type { ParticipantDto, RoomStateDto } from "../contracts/models";
import { readText, writeText } from "../shared/storage/localStore";
import { sharedStateOf } from "../application/room/roomModel";

export interface BackendRoomParticipant {
  participantId: string;
  displayName: string;
  role: string;
  connectionState: string;
  readinessState: string;
  transferProgress?: number;
  voiceLatencyMs?: number;
  voiceTimingReady?: boolean;
  voiceEligible?: boolean;
}

export interface BackendRoom {
  roomId: string;
  hostId: string;
  songId: string | null;
  revision: number | null;
  participants: BackendRoomParticipant[];
  roomPlayoutDelayMs?: number;
  playbackState: string;
  playbackStartedAt: string | null;
  playbackPositionSeconds: number;
  serverNow: string;
  radioEnabled?: boolean;
  radioStationId?: string;
  libraryQuery?: string;
  libraryStatus?: string;
  librarySort?: string;
  playbackRate?: number;
  keyShift?: number;
  musicGain?: number;
  referenceGain?: number;
  melodyGain?: number;
  collaborativeControl?: boolean;
  syncCheckId?: number;
  syncCheckStartedAt?: string | null;
  sharedSongs?: Array<{
    ownerParticipantId: string;
    songId: string;
    revision: number;
    title: string;
    artist: string;
    album: string | null;
    genre: string | null;
    durationSeconds: number;
  }>;
  transferProgress?: number;
}

export interface RoomRequestTiming {
  startedAtMilliseconds: number;
  receivedAtMilliseconds: number;
}

/**
 * Stable across restarts so a reload rejoins as the same participant instead of a new one. The desktop
 * app's id is derived from its private room key, which the room server checks on every request; the
 * stored random id only stands in where there is no desktop bridge (tests, a plain browser).
 */
export const participantId = ((): string => {
  if (typeof window !== "undefined" && window.desktop?.roomParticipantId)
    return window.desktop.roomParticipantId;
  // The key predates versioned storage keys; it stays as it is so a saved id is not lost.
  const key = "adVoice.participantId";
  const stored = typeof window === "undefined" ? null : readText(key);
  if (stored) return stored;
  const created = crypto.randomUUID();
  if (typeof window !== "undefined") writeText(key, created);
  return created;
})();

export const readinessOf = (value: string): ParticipantDto["readiness"] => {
  const known = {
    missingsong: "missing",
    downloading: "downloading",
    importing: "verifying",
    preparing: "audio",
    ready: "ready",
    failed: "failed",
    disconnected: "disconnected",
  } as const;
  return (
    (known as Record<string, ParticipantDto["readiness"]>)[
      value.toLowerCase()
    ] ?? "preparing"
  );
};

export const mapRoom = (
  room: BackendRoom,
  timing?: RoomRequestTiming,
): RoomStateDto => ({
  code: room.roomId,
  hostId: room.hostId,
  songId: room.songId ?? undefined,
  revision: room.revision ?? undefined,
  role: room.hostId === participantId ? "host" : "participant",
  participants: room.participants.map((participant) => ({
    id: participant.participantId,
    name: participant.displayName,
    role: participant.role.toLowerCase() === "host" ? "host" : "participant",
    self: participant.participantId === participantId,
    connected: participant.connectionState.toLowerCase() === "connected",
    muted: false,
    volume: 1,
    readiness: readinessOf(participant.readinessState),
    transferProgress: Math.max(
      0,
      Math.min(
        100,
        participant.transferProgress ??
          (participant.readinessState.toLowerCase() === "ready" ? 100 : 0),
      ),
    ),
    voiceLatencyMs: Math.max(0, Math.min(500, participant.voiceLatencyMs ?? 0)),
    voiceTimingReady: participant.voiceTimingReady ?? false,
    voiceEligible: participant.voiceEligible ?? true,
  })),
  roomPlayoutDelayMs: Math.max(0, Math.min(160, room.roomPlayoutDelayMs ?? 60)),
  transferProgress: Math.max(0, Math.min(100, room.transferProgress ?? 100)),
  playbackLocked: room.playbackState.toLowerCase() === "playing",
  playbackState:
    room.playbackState.toLowerCase() as RoomStateDto["playbackState"],
  playbackStartedAt: room.playbackStartedAt ?? undefined,
  playbackPositionSeconds: room.playbackPositionSeconds,
  serverNow: room.serverNow,
  serverClockOffsetMilliseconds:
    timing && Number.isFinite(Date.parse(room.serverNow))
      ? Date.parse(room.serverNow) -
        (timing.startedAtMilliseconds + timing.receivedAtMilliseconds) / 2
      : undefined,
  ...sharedStateOf(room),
  collaborativeControl: room.collaborativeControl ?? false,
  syncCheckId: room.syncCheckId ?? 0,
  syncCheckStartedAt: room.syncCheckStartedAt ?? undefined,
  sharedSongs: (room.sharedSongs ?? []).map((song) => ({
    ownerParticipantId: song.ownerParticipantId,
    songId: song.songId,
    revision: song.revision,
    title: song.title,
    artist: song.artist,
    album: song.album ?? undefined,
    genre: song.genre ?? undefined,
    durationSeconds: song.durationSeconds,
  })),
});
