"""Each singer contributes only the portions they sang to the shared performance."""

from __future__ import annotations

import math
from dataclasses import replace

from backend.domain_errors import ConflictError, DomainError
from backend.room.access import member_room
from backend.room.domain import ConnectionState, PlaybackState, Room
from backend.room.ports import RoomRepository
from backend.room.serialization import RoomLocks, serialized_by_room


def reset_performance(room: Room) -> Room:
    return replace(
        room,
        performance_id=room.performance_id + 1,
        participants={
            key: replace(
                person,
                performance_accuracy=None,
                performance_sung_seconds=0.0,
                performance_finished=False,
            )
            for key, person in room.participants.items()
        },
    )


def group_performance_accuracy(room: Room) -> float | None:
    singers = [
        person
        for person in room.participants.values()
        if person.performance_accuracy is not None and person.performance_sung_seconds > 0
    ]
    seconds = sum(person.performance_sung_seconds for person in singers)
    return (
        sum(
            (person.performance_accuracy or 0) * person.performance_sung_seconds
            for person in singers
        )
        / seconds
        if seconds > 0
        else None
    )


class PublishRoomPerformance:
    def __init__(self, rooms: RoomRepository, *, locks: RoomLocks) -> None:
        self._rooms = rooms
        self.room_locks = locks

    @serialized_by_room
    def execute(
        self,
        room_id: str,
        actor_id: str,
        performance_id: int,
        accuracy: float,
        sung_seconds: float,
        finished: bool = False,
    ) -> None:
        room = member_room(self._rooms, room_id, actor_id)
        if room.song_id is None or room.performance_id != performance_id:
            raise ConflictError("RoomPerformanceChanged", "This performance is no longer current")
        if (
            room.last_performance_id == performance_id
            or room.participants[actor_id].performance_finished
        ):
            return
        if (
            not math.isfinite(accuracy)
            or not math.isfinite(sung_seconds)
            or not 0 <= accuracy <= 100
            or not 0 <= sung_seconds <= 86400
        ):
            raise DomainError("InvalidPerformanceScore", "Performance score is invalid", 400)
        person = replace(
            room.participants[actor_id],
            performance_accuracy=accuracy if sung_seconds > 0 else None,
            performance_sung_seconds=sung_seconds,
            performance_finished=finished,
        )
        self._rooms.save(
            complete_performance(
                replace(room, participants={**room.participants, actor_id: person})
            )
        )


def complete_performance(room: Room) -> Room:
    singers = [
        person
        for person in room.participants.values()
        if person.connection_state is ConnectionState.CONNECTED
    ]
    if (
        room.song_id is None
        or room.playback_state is not PlaybackState.STOPPED
        or not singers
        or not all(person.performance_finished for person in singers)
    ):
        return room
    return replace(
        room,
        last_performance_id=room.performance_id,
        last_performance_accuracy=group_performance_accuracy(room),
    )
