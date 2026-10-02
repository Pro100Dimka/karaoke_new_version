from __future__ import annotations

from dataclasses import replace

from backend.domain_errors import NotFoundError
from backend.room.access import all_ready
from backend.room.commands import MediaControlCommand, _apply_media_control
from backend.room.domain import PlaybackState, Room, measured_room_playout_delay
from backend.room.ports import RoomRepository
from backend.runtime import Clock


class SetParticipantTiming:
    """Publishes a stable pre-song latency estimate; active playback never moves underneath users."""

    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    def execute(self, room_id: str, participant_id: str, voice_latency_ms: float) -> Room:
        room = self._rooms.get(room_id)
        if room is None:
            raise NotFoundError("RoomNotFound", "Room was not found", roomId=room_id)
        if room.playback_state is not PlaybackState.STOPPED:
            return room
        participant = room.participants.get(participant_id)
        if participant is None:
            raise NotFoundError("ParticipantNotFound", "Room participant was not found")
        participants = dict(room.participants)
        participants[participant_id] = replace(
            participant,
            voice_latency_ms=max(0.0, min(500.0, voice_latency_ms)),
            voice_timing_ready=True,
        )
        updated = replace(
            room,
            participants=participants,
            room_playout_delay_ms=measured_room_playout_delay(participants),
        )
        if updated.song_id is not None and all_ready(updated):
            updated = _apply_media_control(
                updated, MediaControlCommand.START, None, self._clock
            )
        self._rooms.save(updated)
        return updated
