import type { ParticipantDto, RoomStateDto } from "../../contracts/models";

/** A room snapshot may still exist after the server has removed this client. */
export const hasCurrentParticipant = (room: RoomStateDto): boolean =>
  room.participants.some(participant => participant.self);

/** Countdown may start only when every connected participant is Ready. */
export const allConnectedReady = (room: RoomStateDto): boolean =>
  room.participants.filter(participant => participant.connected).every(participant => participant.readiness === "ready");

export const notReadyNames = (room: RoomStateDto): readonly string[] =>
  room.participants
    .filter(participant => participant.connected && participant.readiness !== "ready")
    .map(participant => participant.name);

export interface ParticipantChange {
  joined: readonly ParticipantDto[];
  left: readonly ParticipantDto[];
}

export const diffParticipants = (before: RoomStateDto, after: RoomStateDto): ParticipantChange => {
  const previous = new Set(before.participants.map(participant => participant.id));
  const current = new Set(after.participants.map(participant => participant.id));
  return {
    joined: after.participants.filter(participant => !previous.has(participant.id)),
    left: before.participants.filter(participant => !current.has(participant.id))
  };
};

export const localReadiness = (
  room: RoomStateDto,
  library: readonly { id: string; status: string; activeRevision: number }[],
  importedLocalSongId?: string
): "Ready" | "MissingSong" => {
  const local = library.find(song => song.id === (importedLocalSongId ?? room.songId));
  return local && local.status === "ready" && local.activeRevision === room.revision ? "Ready" : "MissingSong";
};

export const reconcileRemoteParticipants = (
  registered: ReadonlySet<string>,
  room: RoomStateDto
): { add: string[]; remove: string[] } => {
  const wanted = new Set(room.participants.filter(person => !person.self && person.connected !== false).map(person => person.id));
  return {
    add: [...wanted].filter(id => !registered.has(id)),
    remove: [...registered].filter(id => !wanted.has(id))
  };
};

export const applySpeakingLevels = (
  room: RoomStateDto,
  levels: { local: number; remote: Readonly<Record<string, number>> }
): RoomStateDto => ({
  ...room,
  participants: room.participants.map(participant => ({
    ...participant,
    speakingLevel: Math.max(0, Math.min(1, participant.self
      ? levels.local
      : (levels.remote[participant.id] ?? 0)))
  }))
});

const sharedStatuses = ["all", "ready", "processing", "queued", "not-processed", "failed", "invalid"] as const;
const sharedSorts = ["recent", "title", "artist", "played"] as const;

export const sharedLibraryView = (room: RoomStateDto) => ({
  query: room.libraryQuery ?? "",
  status: sharedStatuses.includes(room.libraryStatus as (typeof sharedStatuses)[number])
    ? room.libraryStatus as (typeof sharedStatuses)[number]
    : "all" as const,
  sort: sharedSorts.includes(room.librarySort as (typeof sharedSorts)[number])
    ? room.librarySort as (typeof sharedSorts)[number]
    : "recent" as const
});

export type RoomPlaybackPlan =
  | { kind: "stop" }
  | { kind: "pause"; positionSeconds: number }
  | { kind: "schedule"; delayMilliseconds: number }
  | { kind: "play"; positionSeconds: number };

export const playbackPlan = (room: RoomStateDto): RoomPlaybackPlan => {
  const position = Math.max(0, room.playbackPositionSeconds ?? 0);
  if (room.playbackState === "paused") return { kind: "pause", positionSeconds: position };
  if (room.playbackState !== "playing" || !room.playbackStartedAt || !room.serverNow) return { kind: "stop" };
  const start = Date.parse(room.playbackStartedAt);
  const snapshotNow = Date.parse(room.serverNow);
  const estimatedServerNow = room.serverClockOffsetMilliseconds === undefined
    ? snapshotNow
    : Date.now() + room.serverClockOffsetMilliseconds;
  const deltaMilliseconds = Number.isFinite(start) && Number.isFinite(estimatedServerNow)
    ? start - estimatedServerNow
    : 0;
  if (deltaMilliseconds > 0) return { kind: "schedule", delayMilliseconds: deltaMilliseconds };
  return { kind: "play", positionSeconds: position + Math.max(0, -deltaMilliseconds / 1000) };
};
