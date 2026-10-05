from __future__ import annotations

from dataclasses import replace

from backend.domain_errors import NotFoundError
from backend.room.serialization import serialized_by_room
from backend.room.access import all_ready
from backend.room.commands import MediaControlCommand, _apply_media_control
from backend.room.domain import (
    MAXIMUM_LIVE_ROOM_DELAY_MS,
    ConnectionState,
    PlaybackState,
    Room,
    measured_room_playout_delay,
)
from backend.room.ports import RoomRepository
from backend.runtime import Clock


class SetParticipantTiming:
    """Publishes a stable pre-song latency estimate; active playback never moves underneath users."""

    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    @serialized_by_room
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
        selected_delay = measured_room_playout_delay(participants)
        if room.song_id is None and any(
            item.connection_state is ConnectionState.CONNECTED and not item.voice_eligible
            for item in participants.values()
        ):
            # Idle-room conversation has no musical beat to protect. Keep every listener on the
            # bounded safe deadline; once a song is selected, the strict eligible-singer policy
            # chooses the low fixed performance deadline instead.
            selected_delay = MAXIMUM_LIVE_ROOM_DELAY_MS
        updated = replace(
            room,
            participants=participants,
            room_playout_delay_ms=selected_delay,
        )
        if updated.song_id is not None and all_ready(updated):
            updated = _apply_media_control(
                updated, MediaControlCommand.START, None, self._clock
            )
        self._rooms.save(updated)
        return updated
