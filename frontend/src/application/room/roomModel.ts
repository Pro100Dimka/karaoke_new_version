import { roomServerMixParticipantId } from "../../contracts/clients";
import type { ParticipantDto, RoomStateDto } from "../../contracts/models";

/** The host always controls the shared room; other singers only while the host allows collaborative control. */
export const canControlRoom = (
  room: Pick<RoomStateDto, "role" | "collaborativeControl">,
): boolean => room.role === "host" || room.collaborativeControl === true;

/** A room snapshot may still exist after the server has removed this client. */
export const hasCurrentParticipant = (room: RoomStateDto): boolean =>
  room.participants.some((participant) => participant.self);

/** A recovered control connection must also renew the relay token lost during a server restart. */
export const restoreRoomVoiceAfterReconnect = (
  before: RoomStateDto,
  after: RoomStateDto,
): boolean =>
  before.connectionStatus === "reconnecting" &&
  after.connectionStatus === "connected" &&
  hasCurrentParticipant(after);

/** Countdown starts only after every connected participant is ready and its voice route measured. */
export const allConnectedReady = (room: RoomStateDto): boolean =>
  room.participants
    .filter((participant) => participant.connected)
    .every(
      (participant) =>
        participant.readiness === "ready" &&
        participant.voiceTimingReady === true,
    );
export interface ParticipantChange {
  joined: readonly ParticipantDto[];
  left: readonly ParticipantDto[];
}

export const diffParticipants = (
  before: RoomStateDto,
  after: RoomStateDto,
): ParticipantChange => {
  const previous = new Set(
    before.participants.map((participant) => participant.id),
  );
  const current = new Set(
    after.participants.map((participant) => participant.id),
  );
  return {
    joined: after.participants.filter(
      (participant) => !previous.has(participant.id),
    ),
    left: before.participants.filter(
      (participant) => !current.has(participant.id),
    ),
  };
};

type LibraryEntry = { id: string; status: string; activeRevision: number };

/**
 * Whether this participant must fetch the selected project before it can play: it holds no ready
 * copy of the exact revision, neither under the room's id nor as a copy fetched in an earlier room.
 * A song once transferred is never downloaded again. Readiness and navigation both use this, so a
 * participant never reports ready and then starts a download (which let the host enter karaoke
 * while a guest was still downloading).
 */
export const roomProjectNeedsDownload = (
  room: RoomStateDto,
  library: readonly LibraryEntry[],
  importedLocalSongId?: string,
): boolean =>
  !library.some(
    (song) =>
      (song.id === importedLocalSongId || song.id === room.songId) &&
      song.status === "ready" &&
      song.activeRevision === room.revision,
  );

export const localReadiness = (
  room: RoomStateDto,
  library: readonly LibraryEntry[],
  importedLocalSongId?: string,
): "Ready" | "MissingSong" =>
  roomProjectNeedsDownload(room, library, importedLocalSongId)
    ? "MissingSong"
    : "Ready";

export const reconcileRemoteParticipants = (
  registered: ReadonlySet<string>,
  room: RoomStateDto,
): { add: string[]; remove: string[] } => {
  const hasRemoteSinger = room.participants.some(
    (person) => !person.self && person.connected !== false,
  );
  const wanted = new Set(hasRemoteSinger ? [roomServerMixParticipantId] : []);
  return {
    add: [...wanted].filter((id) => !registered.has(id)),
    remove: [...registered].filter((id) => !wanted.has(id)),
  };
};

const sharedStatuses = [
  "all",
  "ready",
  "importing",
  "processing",
  "queued",
  "not-processed",
  "failed",
  "invalid",
] as const;
const sharedSorts = [
  "recent",
  "title",
  "artist",
  "played",
  "duration",
  "bpm",
] as const;
const sharedDirections = ["asc", "desc"] as const;
const sharedLanguages = [
  "all",
  "Auto",
  "Ukrainian",
  "Russian",
  "English",
] as const;
const sharedDurations = ["all", "short", "medium", "long"] as const;
const sharedArtwork = ["all", "with", "without"] as const;

const allowed = <T extends string>(
  value: string | undefined,
  values: readonly T[],
  fallback: T,
): T => (values.includes(value as T) ? (value as T) : fallback);

export const encodeSharedLibraryView = (view: {
  status: string;
  language: string;
  duration: string;
  artwork: string;
  sort: string;
  direction: string;
}) => ({
  libraryStatus: [view.status, view.language, view.duration, view.artwork].join(
    "|",
  ),
  librarySort: [view.sort, view.direction].join("|"),
});

export const sharedLibraryView = (room: RoomStateDto) => {
  const [status, language, duration, artwork] = (
    room.libraryStatus ?? "all"
  ).split("|");
  const [sort, direction] = (room.librarySort ?? "recent|desc").split("|");
  return {
    query: room.libraryQuery ?? "",
    status: allowed(status, sharedStatuses, "all"),
    language: allowed(language, sharedLanguages, "all"),
    duration: allowed(duration, sharedDurations, "all"),
    artwork: allowed(artwork, sharedArtwork, "all"),
    sort: allowed(sort, sharedSorts, "recent"),
    direction: allowed(direction, sharedDirections, "desc"),
  };
};

export type RoomPlaybackPlan =
  | { kind: "stop" }
  | { kind: "pause"; positionSeconds: number }
  | { kind: "schedule"; delayMilliseconds: number; positionSeconds: number }
  | { kind: "play"; positionSeconds: number };

export const playbackPlan = (room: RoomStateDto): RoomPlaybackPlan => {
  const position = Math.max(0, room.playbackPositionSeconds ?? 0);
  if (room.playbackState === "paused")
    return {
      kind: "pause",
      positionSeconds: position,
    };
  if (
    room.playbackState !== "playing" ||
    !room.playbackStartedAt ||
    !room.serverNow
  )
    return { kind: "stop" };
  const start = Date.parse(room.playbackStartedAt);
  const snapshotNow = Date.parse(room.serverNow);
  const estimatedServerNow =
    room.serverClockOffsetMilliseconds === undefined
      ? snapshotNow
      : performance.now() + room.serverClockOffsetMilliseconds;
  const deltaMilliseconds =
    Number.isFinite(start) && Number.isFinite(estimatedServerNow)
      ? start - estimatedServerNow
      : 0;
  if (deltaMilliseconds > 0)
    return {
      kind: "schedule",
      delayMilliseconds: deltaMilliseconds,
      positionSeconds: position,
    };
  return {
    kind: "play",
    positionSeconds:
      position +
      Math.max(0, -deltaMilliseconds / 1000) * (room.playbackRate ?? 1),
  };
};
