from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

from backend.domain_errors import NotFoundError
from backend.room.serialization import RoomLocks, serialized_by_room
from backend.room.access import load_room
from backend.room.commands import start_ready_room
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
        room = load_room(self._rooms, room_id)
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
        # Refine only the initial countdown, freezing one second before singing. A resumed
        # performance keeps its saved singing timing even during another countdown.
        if room.playback_state is not PlaybackState.PLAYING or (
            room.singing_timing is None
            and room.playback_started_at is not None
            and self._clock.now() < room.playback_started_at - timedelta(seconds=1)
        ):
            updated = updated.with_timing(room_timing(updated))
            updated = start_ready_room(updated, self._clock)
        self._rooms.save(updated)
        return updated


def _bounded(milliseconds: float | None) -> float | None:
    return None if milliseconds is None else max(0.0, min(500.0, milliseconds))
