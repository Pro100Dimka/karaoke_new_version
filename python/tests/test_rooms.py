from __future__ import annotations

import pytest
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.room.commands import CreateRoom, DisconnectParticipant, JoinRoom, ResolveHostDisconnect
from backend.room.domain import HostDisconnectPolicy
from tests.fakes import FakeClock


pytestmark = pytest.mark.integration


def test_host_authority_and_readiness(client) -> None:
    created = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host", "disconnectPolicy": "Transfer"},
    )
    assert created.status_code == 201, created.text
    room_id = created.json()["roomId"]
    joined = client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    assert joined.status_code == 200

    selected = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "song", "revision": 2},
    )
    assert selected.status_code == 200

    not_ready = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Start"},
    )
    assert not_ready.status_code == 409
    assert not_ready.json()["code"] == "RoomNotReady"

    denied = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "guest", "command": "Start"},
    )
    assert denied.status_code == 403
    assert denied.json()["code"] == "RoomPermissionDenied"

    ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready"},
    )
    assert ready.status_code == 200
    started = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Start"},
    )
    assert started.status_code == 200
    assert started.json()["songId"] == "song"
    assert started.json()["revision"] == 2
    snapshot = client.get(f"/rooms/{room_id}")
    assert snapshot.status_code == 200
    assert snapshot.json()["playbackState"] == "Playing"
    assert snapshot.json()["playbackStartedAt"] is not None
    assert snapshot.json()["serverNow"] is not None

    stopped = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Stop"},
    )
    assert stopped.status_code == 200
    assert client.get(f"/rooms/{room_id}").json()["playbackState"] == "Stopped"


def test_host_transfer_is_deterministic(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host", "disconnectPolicy": "Transfer"},
    ).json()
    room_id = room["roomId"]
    for participant in ("b", "a"):
        client.post(
            f"/rooms/{room_id}/join",
            json={"participantId": participant, "displayName": participant.upper()},
        )

    left = client.post(f"/rooms/{room_id}/leave", json={"participantId": "host"})

    assert left.status_code == 200
    assert left.json()["hostId"] == "a"


def test_close_policy_closes_room_when_host_leaves(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host", "disconnectPolicy": "Close"},
    ).json()
    room_id = room["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )

    left = client.post(f"/rooms/{room_id}/leave", json={"participantId": "host"})

    assert left.status_code == 200
    assert left.json() is None
    missing = client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "next", "displayName": "Next"},
    )
    assert missing.status_code == 404
    assert missing.json()["code"] == "RoomNotFound"


def test_room_get_returns_authoritative_snapshot(client) -> None:
    created = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host", "disconnectPolicy": "Transfer"},
    ).json()

    snapshot = client.get(f"/rooms/{created['roomId']}")

    assert snapshot.status_code == 200
    fetched = snapshot.json()
    assert fetched.pop("serverNow") is not None
    assert created.pop("serverNow") is not None
    assert fetched == created


def test_host_disconnect_grace_is_resolved_without_sleep() -> None:

    rooms = InMemoryRoomRepository()
    clock = FakeClock()
    room = CreateRoom(rooms, UuidGenerator()).execute(
        "host",
        "Host",
        HostDisconnectPolicy.TRANSFER,
        host_grace_seconds=10.0,
    )
    JoinRoom(rooms).execute(room.room_id, "guest", "Guest")
    DisconnectParticipant(rooms, clock).execute(room.room_id, "host")

    before_deadline = ResolveHostDisconnect(rooms, clock).execute(room.room_id)
    assert before_deadline is not None
    assert before_deadline.host_id == "host"

    clock.advance(10.0)
    after_deadline = ResolveHostDisconnect(rooms, clock).execute(room.room_id)
    assert after_deadline is not None
    assert after_deadline.host_id == "guest"
