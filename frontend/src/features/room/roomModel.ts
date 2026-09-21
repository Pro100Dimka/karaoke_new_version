import type { ParticipantDto, RoomStateDto } from "../../contracts/models";

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
  library: readonly { id: string; status: string; activeRevision: number }[]
): "Ready" | "MissingSong" => {
  const local = library.find(song => song.id === room.songId);
  return local && local.status === "ready" && local.activeRevision === room.revision ? "Ready" : "MissingSong";
};
