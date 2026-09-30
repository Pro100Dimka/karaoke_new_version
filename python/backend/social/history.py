from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Mapping

from backend.runtime import Clock
from backend.social.domain import Account, Visit
from backend.social.ports import VisitStore


@dataclass(frozen=True, slots=True)
class RoomPerson:
    """Someone who was in the room: known by account when their app said who they are."""

    participant_id: str
    account_id: str | None
    display_name: str


@dataclass(frozen=True, slots=True)
class RoomStay:
    room_id: str
    joined_at: datetime
    left_at: datetime | None
    seconds: float
    people: tuple[RoomPerson, ...]


def _seconds(visits: list[Visit], now: datetime) -> float:
    return sum(((visit.left_at or now) - visit.joined_at).total_seconds() for visit in visits)


def _people(visits: list[Visit], me: Account) -> tuple[RoomPerson, ...]:
    """Everyone else, once each: by account, or by participant for someone never identified."""
    people: dict[str, RoomPerson] = {}
    for visit in sorted(visits, key=lambda item: item.joined_at):
        if visit.account_id == me.account_id:
            continue
        person = RoomPerson(visit.participant_id, visit.account_id, visit.display_name)
        people[visit.account_id or visit.participant_id] = person
    return tuple(people.values())


class RoomHistory:
    """Records who stays in which room and for how long, and tells each person their rooms."""

    def __init__(self, visits: VisitStore, clock: Clock) -> None:
        self._visits = visits
        self._clock = clock

    def record(self, room_id: str, connected: Mapping[str, str]) -> None:
        """The room now has `connected` participants (id to name); an empty map closes it."""
        now = self._clock.now()
        present = set(self._visits.open_participants(room_id))
        gone = tuple(participant for participant in present if participant not in connected)
        if gone:
            self._visits.close_visits(room_id, gone, now)
        for participant_id, name in connected.items():
            if participant_id not in present:
                self._visits.open_visit(Visit(room_id, participant_id, None, name, now, None))

    def recent(self, me: Account, limit: int) -> tuple[RoomStay, ...]:
        room_ids = self._visits.recent_room_ids(me.account_id, limit)
        by_room: dict[str, list[Visit]] = {room_id: [] for room_id in room_ids}
        for visit in self._visits.visits_in(room_ids):
            by_room[visit.room_id].append(visit)
        now = self._clock.now()
        stays = []
        for room_id, visits in by_room.items():
            mine = [visit for visit in visits if visit.account_id == me.account_id]
            if not mine:
                continue
            still_here = any(visit.left_at is None for visit in mine)
            stays.append(
                RoomStay(
                    room_id=room_id,
                    joined_at=min(visit.joined_at for visit in mine),
                    left_at=None if still_here else max(v.left_at or now for v in mine),
                    seconds=_seconds(mine, now),
                    people=_people(visits, me),
                )
            )
        return tuple(sorted(stays, key=lambda stay: stay.joined_at, reverse=True))
