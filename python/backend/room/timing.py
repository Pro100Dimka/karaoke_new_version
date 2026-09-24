from __future__ import annotations

from dataclasses import replace

from backend.domain_errors import NotFoundError
from backend.room.domain import PlaybackState, Room
from backend.room.ports import RoomRepository


class SetParticipantTiming:
    """Publishes a stable pre-song latency estimate; active playback never moves underneath users."""

    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, participant_id: str, voice_latency_ms: float) -> Room:
        room = self._rooms.get(room_id)
        if room is None:
            raise NotFoundError("RoomNotFound", "Room was not found", roomId=room_id)
        if room.playback_state is PlaybackState.PLAYING:
            return room
        participant = room.participants.get(participant_id)
        if participant is None:
            raise NotFoundError("ParticipantNotFound", "Room participant was not found")
        participants = dict(room.participants)
        participants[participant_id] = replace(
            participant, voice_latency_ms=max(0.0, min(500.0, voice_latency_ms))
        )
        updated = replace(room, participants=participants)
        self._rooms.save(updated)
        return updated
