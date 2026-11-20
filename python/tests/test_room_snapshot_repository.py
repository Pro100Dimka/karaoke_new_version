from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from threading import Barrier

import pytest

from backend.api.room_routes import _room
from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.infrastructure.observable_rooms import ObservableRoomRepository
from backend.infrastructure.sqlite_rooms import SqliteRoomRepository
from backend.room.domain import (
    ConnectionState,
    HostDisconnectPolicy,
    Participant,
    ParticipantRole,
    ReadinessState,
    Room,
)
from backend.room.ports import RoomRepository


@pytest.fixture(params=["memory", "sqlite"])
def repositories(request: pytest.FixtureRequest, tmp_path: Path) -> tuple[RoomRepository, ...]:
    if request.param == "memory":
        repository = InMemoryRoomRepository()
        return (repository, repository)
    path = tmp_path / "rooms.sqlite3"
    # Separate instances also exercise SQLite's transaction boundary, beyond a Python lock.
    return (SqliteRoomRepository(path), SqliteRoomRepository(path))


def _candidate(query: str = "") -> Room:
    host = Participant(
        "host", "Host", ParticipantRole.HOST, ConnectionState.CONNECTED, ReadinessState.READY
    )
    return Room("room", "host", {"host": host}, HostDisconnectPolicy.TRANSFER, library_query=query)


def test_retained_saved_snapshot_keeps_its_own_revision_and_values(
    repositories: tuple[RoomRepository, ...],
) -> None:
    repository = repositories[0]
    candidate = _candidate("a")
    first = repository.save(candidate)
    second = repository.save(replace(candidate, library_query="ab"))

    assert isinstance(first, Room), "save must return the exact versioned snapshot it persisted"
    assert isinstance(second, Room)
    # Serialization happens after the newer save, as with a delayed HTTP reply.
    newer_response = _room(second).model_dump(by_alias=True)
    delayed_response = _room(first).model_dump(by_alias=True)
    assert candidate.snapshot_revision == 0
    assert first is not candidate
    assert 0 < delayed_response["snapshotRevision"] < newer_response["snapshotRevision"]
    assert delayed_response["libraryQuery"] == "a"
    assert newer_response["libraryQuery"] == "ab"
    assert repository.get("room") == second


def test_concurrent_saves_keep_payloads_paired_with_unique_revisions(
    repositories: tuple[RoomRepository, ...],
) -> None:
    writers = 4
    begin = Barrier(writers)
    saved = Barrier(writers)

    def write(index: int) -> tuple[Room, dict[str, object], Room | None]:
        repository = repositories[index % len(repositories)]
        begin.wait(timeout=5)
        result = repository.save(_candidate(f"query-{index}"))
        saved.wait(timeout=5)
        assert isinstance(result, Room)
        return result, _room(result).model_dump(by_alias=True), repository.get("room")

    with ThreadPoolExecutor(max_workers=writers) as executor:
        results = list(executor.map(write, range(writers)))

    revisions = {result.snapshot_revision for result, _, _ in results}
    assert len(revisions) == writers
    assert min(revisions) > 0
    latest = max((result for result, _, _ in results), key=lambda room: room.snapshot_revision)
    for index, (result, response, current) in enumerate(results):
        assert response["libraryQuery"] == result.library_query == f"query-{index}"
        assert response["snapshotRevision"] == result.snapshot_revision
        assert current == latest


def test_unchanged_save_keeps_revision_and_repository_owns_new_revisions(
    repositories: tuple[RoomRepository, ...],
) -> None:
    repository = repositories[0]
    first = repository.save(_candidate("a"))
    assert isinstance(first, Room)
    unchanged = repository.save(replace(first))
    assert unchanged == first
    changed = repository.save(replace(first, library_query="b", snapshot_revision=1_000_000))
    assert changed.snapshot_revision == first.snapshot_revision + 1
    assert changed.library_query == "b"


def test_participant_order_change_is_saved_for_host_failover(
    repositories: tuple[RoomRepository, ...],
) -> None:
    repository = repositories[0]
    candidate = _candidate()
    guests = {
        name: replace(
            candidate.participants["host"], participant_id=name, role=ParticipantRole.PARTICIPANT
        )
        for name in ("first", "second")
    }
    first = repository.save(replace(candidate, participants={**candidate.participants, **guests}))
    reordered = {key: first.participants[key] for key in ("host", "second", "first")}
    second = repository.save(replace(first, participants=reordered))
    # Host transfer uses join order, even when all participant values are otherwise equal.
    assert tuple(second.participants) == ("host", "second", "first")
    assert second.snapshot_revision > first.snapshot_revision
    stored = repository.get("room")
    assert stored is not None
    assert tuple(stored.participants) == tuple(second.participants)


def test_revision_survives_sqlite_reopen_other_rooms_and_code_reuse(tmp_path: Path) -> None:
    path = tmp_path / "rooms.sqlite3"
    first = SqliteRoomRepository(path).save(_candidate("a"))
    assert isinstance(first, Room)
    reopened = SqliteRoomRepository(path)
    assert reopened.get("room") == first
    second = reopened.save(replace(first, library_query="b"))
    other = reopened.save(replace(_candidate("other"), room_id="other"))
    reopened.delete("room")
    recreated = SqliteRoomRepository(path).save(_candidate("recreated"))
    assert first.snapshot_revision < second.snapshot_revision < other.snapshot_revision
    assert other.snapshot_revision < recreated.snapshot_revision
    assert recreated.library_query == "recreated"


def test_legacy_sqlite_json_loads_without_rewrite_and_upgrades_on_save(tmp_path: Path) -> None:
    path = tmp_path / "rooms.sqlite3"
    # A historical payload, independent of the current encoder and its new optional fields.
    payload = json.dumps(
        {
            "roomId": "room",
            "hostId": "host",
            "disconnectPolicy": "Transfer",
            "hostGraceSeconds": 10,
            "songId": None,
            "revision": None,
            "playbackState": "Stopped",
            "playbackPositionSeconds": 0,
            "libraryQuery": "legacy query",
            "participants": [
                {
                    "participantId": "host",
                    "displayName": "Host",
                    "role": "Host",
                    "connectionState": "Connected",
                    "readinessState": "Ready",
                }
            ],
        }
    )
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE rooms (room_id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        connection.execute("INSERT INTO rooms VALUES (?, ?)", ("room", payload))

    repository = SqliteRoomRepository(path)
    legacy = repository.get("room")
    assert legacy is not None
    assert legacy.snapshot_revision == 0
    assert legacy.library_query == "legacy query"
    assert SqliteRoomRepository(path).get("room") == legacy
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT payload FROM rooms").fetchone()[0] == payload

    upgraded = repository.save(legacy)
    assert upgraded.snapshot_revision > 0
    assert upgraded.library_query == "legacy query"
    assert SqliteRoomRepository(path).get("room") == upgraded


def test_failed_sqlite_write_does_not_commit_revision_without_payload(tmp_path: Path) -> None:
    path = tmp_path / "rooms.sqlite3"
    repository = SqliteRoomRepository(path)
    first = repository.save(_candidate("a"))
    assert isinstance(first, Room)
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TRIGGER reject_room_update BEFORE UPDATE ON rooms "
            "BEGIN SELECT RAISE(ABORT, 'injected write failure'); END"
        )
    with pytest.raises(sqlite3.IntegrityError, match="injected write failure"):
        repository.save(replace(first, library_query="failed"))
    assert SqliteRoomRepository(path).get("room") == first
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TRIGGER reject_room_update")
    recovered = repository.save(replace(first, library_query="recovered"))
    assert recovered.snapshot_revision == first.snapshot_revision + 1
    assert recovered.library_query == "recovered"


def test_observers_receive_the_exact_saved_snapshot(
    repositories: tuple[RoomRepository, ...],
) -> None:
    repository = ObservableRoomRepository(repositories[0])
    seen: list[tuple[str, Room | None]] = []
    repository.listen(lambda room_id, room: seen.append((room_id, room)))
    first = repository.save(_candidate("a"))
    second = repository.save(_candidate("b"))
    assert isinstance(first, Room)
    assert isinstance(second, Room)
    assert seen[0][0] == seen[1][0] == "room"
    assert seen[0][1] is first
    assert seen[1][1] is second
    assert first.snapshot_revision < second.snapshot_revision
    assert repository.get("room") == second


def test_listener_failure_leaves_committed_snapshot_and_wake_cursor_observable() -> None:
    repository = ObservableRoomRepository(InMemoryRoomRepository())
    first = repository.save(_candidate("a"))
    assert isinstance(first, Room)
    previous_cursor = repository.version("room")

    def fail_listener(_room_id: str, _room: Room | None) -> None:
        raise RuntimeError("injected listener failure")

    repository.listen(fail_listener)
    with pytest.raises(RuntimeError, match="injected listener failure"):
        repository.save(replace(first, library_query="committed"))
    stored = repository.get("room")
    assert stored is not None
    assert stored.library_query == "committed"
    assert stored.snapshot_revision > first.snapshot_revision
    assert repository.wait_for_change("room", previous_cursor, timeout=0) > previous_cursor
