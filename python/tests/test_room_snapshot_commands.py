from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import backend.api.room_routes as room_routes
from backend.api.room_server_app import _add_change_route
from backend.bootstrap.room_wiring import RoomCases, build_room_cases
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.infrastructure.observable_rooms import ObservableRoomRepository
from backend.room.commands import MediaControlCommand
from backend.room.domain import HostDisconnectPolicy, ReadinessState, Room, RoomSong
from tests.fakes import FakeClock


@pytest.fixture
def room_cases() -> tuple[RoomCases, ObservableRoomRepository, FakeClock]:
    repository = ObservableRoomRepository(InMemoryRoomRepository())
    clock = FakeClock()
    return build_room_cases(UuidGenerator(), clock, repository), repository, clock


def _shared(cases: RoomCases, room_id: str, query: str) -> Room:
    return cases.update_shared_state.execute(
        room_id,
        "host",
        radio_enabled=False,
        radio_station_id="groove-salad",
        library_query=query,
        library_status="all",
        library_sort="recent",
        playback_rate=1.0,
        key_shift=0,
        music_gain=0.82,
        reference_gain=0.0,
        melody_gain=0.0,
    )


def _app(cases: RoomCases, repository: ObservableRoomRepository) -> FastAPI:
    # Exercise the real routes in-process without starting a relay, server socket or sweeper.
    app = FastAPI()
    app.state.container = SimpleNamespace(rooms=cases)
    app.include_router(room_routes.router)
    _add_change_route(app, repository)
    return app


def test_delayed_shared_state_response_keeps_revision_older_than_newest_get(
    room_cases: tuple[RoomCases, ObservableRoomRepository, FakeClock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cases, repository, _ = room_cases
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    original_serializer = room_routes._room
    captured: list[Room] = []

    def publish_newer_before_serializing(older: Room) -> room_routes.RoomDto:
        captured.append(older)
        _shared(cases, room.room_id, "ab")
        return original_serializer(older)

    with TestClient(_app(cases, repository)) as client:
        monkeypatch.setattr(room_routes, "_room", publish_newer_before_serializing)
        delayed = client.post(
            f"/rooms/{room.room_id}/shared-state",
            json={
                "participantId": "host",
                "radioEnabled": False,
                "radioStationId": "groove-salad",
                "libraryQuery": "a",
                "libraryStatus": "all",
                "librarySort": "recent",
            },
        )
        monkeypatch.setattr(room_routes, "_room", original_serializer)
        current = client.get(f"/rooms/{room.room_id}")
    assert delayed.status_code == current.status_code == 200
    assert delayed.json()["libraryQuery"] == captured[0].library_query == "a"
    assert current.json()["libraryQuery"] == "ab"
    assert 0 < delayed.json()["snapshotRevision"] < current.json()["snapshotRevision"]
    assert delayed.json()["snapshotRevision"] == captured[0].snapshot_revision
    assert current.json()["snapshotRevision"] == cases.get.execute(room.room_id).snapshot_revision


def test_change_wake_cursor_cannot_relabel_a_newer_room_snapshot(
    room_cases: tuple[RoomCases, ObservableRoomRepository, FakeClock],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cases, repository, _ = room_cases
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    captured_cursor = repository.version(room.room_id)
    saved: list[Room] = []

    def change_after_cursor(room_id: str, after: int, timeout: float = 25.0) -> int:
        assert room_id == room.room_id and after == 0
        saved.append(_shared(cases, room_id, "collaborator"))
        return captured_cursor

    monkeypatch.setattr(repository, "wait_for_change", change_after_cursor)
    with TestClient(_app(cases, repository)) as client:
        response = client.get(
            f"/rooms/{room.room_id}/changes", params={"participantId": "host", "after": 0}
        )
    assert response.status_code == 200
    body = response.json()
    assert body["version"] == captured_cursor < repository.version(room.room_id)
    assert body["room"]["libraryQuery"] == "collaborator"
    assert body["room"]["snapshotRevision"] == saved[0].snapshot_revision
    assert body["room"]["snapshotRevision"] > room.snapshot_revision


def test_room_commands_return_the_exact_snapshot_observed_after_save(
    room_cases: tuple[RoomCases, ObservableRoomRepository, FakeClock],
) -> None:
    cases, repository, clock = room_cases
    seen: list[Room | None] = []
    repository.listen(lambda _room_id, room: seen.append(room))

    def saved(result: Room | None) -> Room:
        assert isinstance(result, Room)
        assert result is seen[-1]
        assert result is repository.get(result.room_id)
        assert result.snapshot_revision > 0
        return result

    room = saved(cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER))
    code = room.room_id
    saved(cases.join.execute(code, "guest", "Guest"))
    saved(cases.set_collaborative_control.execute(code, "host", True))
    saved(_shared(cases, code, "a"))
    songs = tuple(RoomSong("host", name, 1, name, "", None, None, 30) for name in ("one", "two"))
    saved(cases.publish_library.execute(code, "host", songs))
    selected = saved(cases.select_song.execute(code, "host", "one", 1))
    saved(cases.set_timing.execute(code, "host", 30))
    saved(cases.set_timing.execute(code, "guest", 30))
    for participant in ("host", "guest"):
        saved(
            cases.set_readiness.execute(
                code, participant, ReadinessState.READY, selection_id=selected.selection_id
            )
        )
    saved(cases.authorize_control.execute(code, "host", MediaControlCommand.STOP))
    saved(cases.start_sync_check.execute(code, "host"))
    saved(cases.voice_settings.execute(code, "host", "host", {"echo": 0.1}, initialize=True))
    saved(cases.clear_song.execute(code, "host"))
    playlist = saved(cases.playlist.execute(code, "host", "Set", (("one", 1), ("two", 1))))
    saved(cases.playlist.advance(code, "host", playlist.performance_id))
    second = saved(cases.playlist.advance(code, "guest", playlist.performance_id))
    saved(cases.playlist.advance(code, "host", second.performance_id))
    saved(cases.playlist.advance(code, "guest", second.performance_id))
    saved(cases.transfer_host.execute(code, "host", "guest"))
    saved(cases.disconnect.execute(code, "guest"))
    clock.advance(11)
    saved(cases.resolve_host_disconnect.execute(code))
    saved(cases.join.execute(code, "guest", "Guest"))
    saved(cases.remove_participant.execute(code, "host", "guest"))
    saved(cases.join.execute(code, "guest", "Guest"))
    saved(cases.leave.execute(code, "guest"))
    saved(cases.join.execute(code, "guest", "Guest"))
    saved(cases.leave.execute(code, "host"))


def test_reads_and_noop_commands_retain_the_stored_revision(
    room_cases: tuple[RoomCases, ObservableRoomRepository, FakeClock],
) -> None:
    cases, repository, _ = room_cases
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    initialized = cases.voice_settings.execute(
        room.room_id, "host", "host", {"echo": 0.1}, initialize=True
    )
    same_results = [
        cases.get.execute(room.room_id),
        cases.resolve_host_disconnect.execute(room.room_id),
        cases.transfer_host.execute(room.room_id, "host", "host"),
        cases.voice_settings.execute(room.room_id, "host", "host", {"echo": 0.1}),
        cases.voice_settings.execute(room.room_id, "host", "host", {"echo": 0.8}, initialize=True),
        cases.playlist.advance(room.room_id, "host", initialized.performance_id),
        _shared(cases, room.room_id, ""),
    ]
    assert initialized.snapshot_revision > 0
    for result in same_results:
        assert result is not None
        assert result.snapshot_revision == initialized.snapshot_revision
        assert result == initialized
    assert repository.get(room.room_id) == initialized


def test_performance_writes_and_late_results_keep_versions_with_their_values(
    room_cases: tuple[RoomCases, ObservableRoomRepository, FakeClock],
) -> None:
    cases, repository, _ = room_cases
    room = cases.create.execute("host", "Host", HostDisconnectPolicy.TRANSFER)
    selected = cases.select_song.execute(room.room_id, "host", "one", 1)
    cases.publish_performance.execute(room.room_id, "host", selected.performance_id, 80, 5)
    scored = cases.get.execute(room.room_id)
    assert selected.snapshot_revision < scored.snapshot_revision
    assert scored.participants["host"].performance_accuracy == 80
    cleared = cases.clear_song.execute(room.room_id, "host")
    cases.publish_performance.execute(room.room_id, "host", selected.performance_id, 90, 6, True)
    finished = cases.get.execute(room.room_id)
    assert cleared.snapshot_revision < finished.snapshot_revision
    assert finished.performance_history[selected.performance_id]["host"].accuracy == 90
    cases.publish_performance.execute(room.room_id, "host", selected.performance_id, 95, 7, True)
    assert repository.get(room.room_id) == finished
