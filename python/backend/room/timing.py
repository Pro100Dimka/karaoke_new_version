from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

from backend.domain_errors import NotFoundError
from backend.room.serialization import RoomLocks, serialized_by_room
from backend.room.access import all_ready
from backend.room.commands import MediaControlCommand, _apply_media_control
from backend.room.domain import PlaybackState, Room, room_timing
from backend.room.ports import RoomRepository
from backend.runtime import Clock


class SetParticipantTiming:
    """Updates a route while keeping the room deadline and timeline fixed during playback."""

    def __init__(self, rooms: RoomRepository, clock: Clock, *, locks: RoomLocks) -> None:
        self._rooms = rooms
        self.room_locks = locks
        self._clock = clock

    @serialized_by_room
    def execute(
        self,
        room_id: str,
        participant_id: str,
        voice_latency_ms: float,
        return_requirement_ms: float | None = None,
        arrival_requirement_ms: float | None = None,
        route_calibrated: bool = True,
    ) -> Room:
        room = self._rooms.get(room_id)
        if room is None:
            raise NotFoundError("RoomNotFound", "Room was not found", roomId=room_id)
        participant = room.participants.get(participant_id)
        if participant is None:
            raise NotFoundError("ParticipantNotFound", "Room participant was not found")
        participants = dict(room.participants)
        participants[participant_id] = replace(
            participant,
            voice_latency_ms=max(0.0, min(500.0, voice_latency_ms)),
            voice_timing_ready=True,
            return_requirement_ms=_bounded(return_requirement_ms),
            arrival_requirement_ms=_bounded(arrival_requirement_ms),
            voice_route_calibrated=route_calibrated,
        )
        updated = replace(room, participants=participants)
        # The scheduled start leaves two seconds to refine route measurements while the intro
        # screen is visible. Freeze one second before singing so every client receives the same
        # final return reserve before rendering the first position.
        calibrating_countdown = (
            room.playback_state is PlaybackState.PLAYING
            and room.playback_started_at is not None
            and self._clock.now() < room.playback_started_at - timedelta(seconds=1)
        )
        if room.playback_state is not PlaybackState.PLAYING or calibrating_countdown:
            updated = updated.with_timing(room_timing(updated))
            if room.playback_state is PlaybackState.STOPPED and updated.song_id is not None and all_ready(updated):
                updated = _apply_media_control(
                    updated, MediaControlCommand.START, None, self._clock
                )
        self._rooms.save(updated)
        return updated


def _bounded(milliseconds: float | None) -> float | None:
    return None if milliseconds is None else max(0.0, min(500.0, milliseconds))
