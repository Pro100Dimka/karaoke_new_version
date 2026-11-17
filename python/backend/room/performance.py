"""Each singer contributes only the portions they sang to the shared performance."""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import replace

from backend.domain_errors import ConflictError, DomainError
from backend.room.access import member_room
from backend.room.domain import (
    ConnectionState,
    PlaybackState,
    Room,
    RoomPerformanceScore,
    RoomPerformanceResult,
)
from backend.room.ports import RoomRepository
from backend.room.serialization import RoomLocks, serialized_by_room

# Recent rounds remain addressable while clients finish saving or move to the next song.
_HISTORY_LIMIT = 64


def _snapshot(room: Room) -> dict[str, RoomPerformanceScore]:
    return {
        key: RoomPerformanceScore(
            person.performance_accuracy,
            person.performance_sung_seconds,
            person.performance_finished,
        )
        for key, person in room.participants.items()
    }


def _remember(room: Room) -> dict[int, dict[str, RoomPerformanceScore]]:
    history = {key: dict(value) for key, value in room.performance_history.items()}
    scores = _snapshot(room)
    if room.performance_id > 0 and any(
        score.finished or score.sung_seconds > 0 for score in scores.values()
    ):
        history[room.performance_id] = scores
    return dict(sorted(history.items())[-_HISTORY_LIMIT:])


def reset_performance(room: Room) -> Room:
    return replace(
        room,
        performance_history=_remember(room),
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
    return _average(_snapshot(room).values())


def _average(scores: Iterable[RoomPerformanceScore]) -> float | None:
    singers = [
        person for person in scores if person.accuracy is not None and person.sung_seconds > 0
    ]
    seconds = sum(person.sung_seconds for person in singers)
    return (
        sum((person.accuracy or 0) * person.sung_seconds for person in singers) / seconds
        if seconds > 0
        else None
    )


def performance_result(room: Room, performance_id: int) -> RoomPerformanceResult:
    scores = (
        _snapshot(room)
        if performance_id == room.performance_id and room.song_id is not None
        else room.performance_history.get(performance_id, {})
    )
    connected = {
        key
        for key, person in room.participants.items()
        if person.connection_state is ConnectionState.CONNECTED
    }
    complete = (
        bool(scores)
        and all(score.finished or key not in connected for key, score in scores.items())
        and (performance_id != room.performance_id or room.playback_state is PlaybackState.STOPPED)
    )
    return {"complete": complete, "score": _average(scores.values()) if complete else None}


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
        if (
            not math.isfinite(accuracy)
            or not math.isfinite(sung_seconds)
            or not 0 <= accuracy <= 100
            or not 0 <= sung_seconds <= 86400
        ):
            raise DomainError("InvalidPerformanceScore", "Performance score is invalid", 400)
        if room.performance_id != performance_id or room.song_id is None:
            if not finished:
                raise ConflictError(
                    "RoomPerformanceChanged", "This performance is no longer current"
                )
            self._rooms.save(
                _finish_previous(room, actor_id, performance_id, accuracy, sung_seconds)
            )
            return
        if room.participants[actor_id].performance_finished:
            return
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


def _finish_previous(
    room: Room, actor_id: str, performance_id: int, accuracy: float, sung_seconds: float
) -> Room:
    previous = room.performance_history.get(performance_id)
    if previous is None or actor_id not in previous:
        raise ConflictError("RoomPerformanceChanged", "This performance is no longer current")
    if previous[actor_id].finished:
        return room
    scores = {
        **previous,
        actor_id: RoomPerformanceScore(accuracy if sung_seconds > 0 else None, sung_seconds, True),
    }
    updated = replace(
        room, performance_history={**room.performance_history, performance_id: scores}
    )
    if performance_result(updated, performance_id)["complete"] and performance_id >= (
        room.last_performance_id or 0
    ):
        updated = replace(
            updated,
            last_performance_id=performance_id,
            last_performance_accuracy=_average(scores.values()),
        )
    return updated


def complete_performance(room: Room) -> Room:
    if room.song_id is not None and room.playback_state is PlaybackState.STOPPED:
        room = replace(room, performance_history=_remember(room))
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
