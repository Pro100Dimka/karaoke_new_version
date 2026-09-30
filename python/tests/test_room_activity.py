from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.api.room_server_app import _RoomHousekeeping, create_room_server_app
from backend.bootstrap.room_wiring import build_room_cases
from backend.infrastructure.clock import UtcClock
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.infrastructure.observable_rooms import ObservableRoomRepository
from backend.infrastructure.room_activity import RoomActivity
from backend.infrastructure.room_project_folders import RoomProjectFolders
from backend.room.domain import HostDisconnectPolicy

_HOUR = 3600.0


def test_a_room_counts_as_idle_only_after_an_hour_without_requests() -> None:
    clock = [0.0]
    activity = RoomActivity(now=lambda: clock[0])
    activity.touch("used")
    assert activity.idle(("used", "forgotten"), _HOUR) == ()  # "forgotten" counts from this sweep
    clock[0] = _HOUR - 1
    activity.touch("used")
    assert activity.idle(("used", "forgotten"), _HOUR) == ()
    clock[0] = _HOUR + 1
    assert activity.idle(("used", "forgotten"), _HOUR) == ("forgotten",)
    clock[0] = 2 * _HOUR
    assert activity.idle(("used",), _HOUR) == ("used",)


def test_a_deleted_room_is_forgotten_by_the_activity_tracker() -> None:
    clock = [0.0]
    activity = RoomActivity(now=lambda: clock[0])
    activity.touch("gone")
    assert activity.idle((), _HOUR) == ()
    clock[0] = 10 * _HOUR
    assert activity.idle(("gone",), _HOUR) == ()  # recreated with the same id: a fresh start


def test_the_sweep_removes_an_abandoned_room_but_keeps_a_used_one(tmp_path: Path) -> None:
    clock = [0.0]
    repository = ObservableRoomRepository(InMemoryRoomRepository())
    cases = build_room_cases(UuidGenerator(), UtcClock(), repository)
    used = cases.create.execute("host-1", "Host", HostDisconnectPolicy.TRANSFER)
    abandoned = cases.create.execute("host-2", "Host", HostDisconnectPolicy.TRANSFER)
    activity = RoomActivity(now=lambda: clock[0])
    housekeeping = _RoomHousekeeping(cases, repository, activity, RoomProjectFolders(tmp_path))
    housekeeping.sweep_once()
    clock[0] = 2 * _HOUR
    activity.touch(used.room_id)
    housekeeping.sweep_once()  # the sweep reads both rooms; that is not activity
    assert repository.get(used.room_id) is not None
    assert repository.get(abandoned.room_id) is None


def test_room_requests_pass_through_the_activity_tracking_unchanged() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        created = client.post("/rooms", json={"participantId": "host-1", "displayName": "Host"})
        code = created.json()["roomId"]
        assert client.get(f"/rooms/{code.upper()}").status_code == 200
