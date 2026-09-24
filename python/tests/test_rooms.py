from __future__ import annotations

import pytest
from datetime import datetime
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
    client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "host", "readiness": "Ready"},
    )
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

    denied_exit = client.post(
        f"/rooms/{room_id}/song/clear",
        json={"participantId": "guest"},
    )
    assert denied_exit.status_code == 403

    exited = client.post(
        f"/rooms/{room_id}/song/clear",
        json={"participantId": "host"},
    )
    assert exited.status_code == 200
    assert exited.json()["songId"] is None
    assert exited.json()["revision"] is None
    assert exited.json()["playbackState"] == "Stopped"


def test_selected_song_starts_automatically_only_after_every_participant_is_ready(client) -> None:
    created = client.post(
        "/rooms", json={"participantId": "host", "displayName": "Host"}
    ).json()
    room_id = created["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    selected = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "song", "revision": 2},
    ).json()
    assert selected["playbackState"] == "Stopped"

    host_ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "host", "readiness": "Ready"},
    )
    assert host_ready.json()["playbackState"] == "Stopped"

    ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready"},
    )

    assert ready.status_code == 200, ready.text
    assert ready.json()["playbackState"] == "Playing"
    assert ready.json()["playbackStartedAt"] is not None


def test_already_downloaded_room_song_starts_only_after_both_players_are_prepared(client) -> None:
    room_id = client.post(
        "/rooms", json={"participantId": "host", "displayName": "Host"}
    ).json()["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    song = {
        "songId": "cached-song",
        "revision": 4,
        "title": "Cached song",
        "artist": "Artist",
        "durationSeconds": 120,
    }
    for participant_id in ("host", "guest"):
        published = client.post(
            f"/rooms/{room_id}/library",
            json={"participantId": participant_id, "songs": [song]},
        )
        assert published.status_code == 200, published.text

    selected = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "cached-song", "revision": 4},
    )

    assert selected.status_code == 200, selected.text
    assert {
        person["participantId"]: person["readinessState"]
        for person in selected.json()["participants"]
    } == {"host": "Preparing", "guest": "Preparing"}
    assert selected.json()["playbackState"] == "Stopped"

    host_ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "host", "readiness": "Ready"},
    ).json()
    assert host_ready["playbackState"] == "Stopped"
    guest_ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready"},
    ).json()
    assert guest_ready["playbackState"] == "Playing"
    assert guest_ready["playbackStartedAt"] is not None


def test_room_transfer_progress_is_authoritative_and_identical_for_every_client(client) -> None:
    room_id = client.post(
        "/rooms", json={"participantId": "host", "displayName": "Host"}
    ).json()["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "song", "revision": 2},
    )

    uploading = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Downloading", "progress": 37},
    )
    assert uploading.status_code == 200, uploading.text
    assert uploading.json()["transferProgress"] == 37
    assert client.get(f"/rooms/{room_id}").json()["transferProgress"] == 37

    ready = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready", "progress": 100},
    )
    assert ready.status_code == 200, ready.text
    assert ready.json()["transferProgress"] == 100


def test_selecting_another_participants_song_marks_its_owner_ready_not_the_controller(client) -> None:
    created = client.post(
        "/rooms", json={"participantId": "host", "displayName": "Host"}
    ).json()
    room_id = created["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    published = client.post(
        f"/rooms/{room_id}/library",
        json={
            "participantId": "guest",
            "songs": [{
                "songId": "guest-song",
                "revision": 3,
                "title": "Guest song",
                "artist": "Guest",
                "durationSeconds": 120,
            }],
        },
    )
    assert published.status_code == 200, published.text

    selected = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "guest-song", "revision": 3},
    )

    assert selected.status_code == 200, selected.text
    participants = {
        person["participantId"]: person for person in selected.json()["participants"]
    }
    assert participants["guest"]["readinessState"] == "Preparing"
    assert participants["host"]["readinessState"] == "MissingSong"
    assert selected.json()["playbackState"] == "Stopped"


def test_room_sync_check_schedules_one_shared_future_click_sequence(client) -> None:
    created = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()
    room_id = created["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )

    first = client.post(
        f"/rooms/{room_id}/sync-check", json={"participantId": "guest"}
    )
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["syncCheckId"] == 1
    assert datetime.fromisoformat(payload["syncCheckStartedAt"]) > datetime.fromisoformat(
        payload["serverNow"]
    )

    second = client.post(
        f"/rooms/{room_id}/sync-check", json={"participantId": "host"}
    )
    assert second.status_code == 200, second.text
    assert second.json()["syncCheckId"] == 2


def test_host_can_enable_equal_room_controls_for_participants(client) -> None:
    created = client.post("/rooms", json={"participantId": "host", "displayName": "Host"})
    room_id = created.json()["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )

    denied = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "guest", "songId": "guest-song", "revision": 1},
    )
    assert denied.status_code == 403

    enabled = client.post(
        f"/rooms/{room_id}/collaborative-control",
        json={"participantId": "host", "enabled": True},
    )
    assert enabled.status_code == 200, enabled.text
    assert enabled.json()["collaborativeControl"] is True

    selected = client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "guest", "songId": "guest-song", "revision": 1},
    )
    assert selected.status_code == 200, selected.text
    client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "host", "readiness": "Ready"},
    )
    client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready"},
    )
    started = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "guest", "command": "Start"},
    )
    assert started.status_code == 200, started.text

    guest_cannot_change_policy = client.post(
        f"/rooms/{room_id}/collaborative-control",
        json={"participantId": "guest", "enabled": False},
    )
    assert guest_cannot_change_policy.status_code == 403


def test_host_transfer_uses_the_oldest_connected_participant(client) -> None:
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
    assert left.json()["hostId"] == "b"


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


def test_host_can_explicitly_transfer_authority_to_a_connected_participant(client) -> None:
    room = client.post(
        "/rooms", json={"participantId": "host", "displayName": "Host"}
    ).json()
    room_id = room["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )

    transferred = client.post(
        f"/rooms/{room_id}/host",
        json={"participantId": "host", "targetParticipantId": "guest"},
    )

    assert transferred.status_code == 200, transferred.text
    snapshot = transferred.json()
    assert snapshot["hostId"] == "guest"
    roles = {person["participantId"]: person["role"] for person in snapshot["participants"]}
    assert roles == {"host": "Participant", "guest": "Host"}


def test_host_can_remove_a_participant_and_their_published_songs(client) -> None:
    room = client.post(
        "/rooms", json={"participantId": "host", "displayName": "Host"}
    ).json()
    room_id = room["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    client.post(
        f"/rooms/{room_id}/library",
        json={
            "participantId": "guest",
            "songs": [{
                "songId": "guest-song", "revision": 1, "title": "Guest song",
                "artist": "Guest", "durationSeconds": 120,
            }],
        },
    )

    kicked = client.post(
        f"/rooms/{room_id}/participants/guest/remove",
        json={"participantId": "host"},
    )

    assert kicked.status_code == 200, kicked.text
    assert [person["participantId"] for person in kicked.json()["participants"]] == ["host"]
    assert kicked.json()["sharedSongs"] == []
    denied = client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "guest", "readiness": "Ready"},
    )
    assert denied.status_code == 404


def test_host_can_close_the_room_explicitly(client) -> None:
    room = client.post(
        "/rooms", json={"participantId": "host", "displayName": "Host"}
    ).json()
    room_id = room["roomId"]

    closed = client.post(f"/rooms/{room_id}/close", json={"participantId": "host"})

    assert closed.status_code == 204, closed.text
    assert client.get(f"/rooms/{room_id}").status_code == 404


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


def test_room_snapshot_synchronizes_radio_search_and_filters(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host"},
    ).json()
    room_id = room["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )

    updated = client.post(
        f"/rooms/{room_id}/shared-state",
        json={
            "participantId": "host",
            "radioEnabled": True,
            "radioStationId": "groove-salad",
            "libraryQuery": "Надія",
            "libraryStatus": "ready",
            "librarySort": "artist",
            "playbackRate": 0.9,
            "keyShift": -2,
        },
    )

    assert updated.status_code == 200
    snapshot = client.get(f"/rooms/{room_id}").json()
    assert snapshot["radioEnabled"] is True
    assert snapshot["radioStationId"] == "groove-salad"
    assert snapshot["libraryQuery"] == "Надія"
    assert snapshot["libraryStatus"] == "ready"
    assert snapshot["librarySort"] == "artist"
    assert snapshot["playbackRate"] == 0.9
    assert snapshot["keyShift"] == -2

    denied = client.post(
        f"/rooms/{room_id}/shared-state",
        json={
            "participantId": "guest",
            "radioEnabled": True,
            "radioStationId": "groove-salad",
            "libraryQuery": "Надія",
            "libraryStatus": "ready",
            "librarySort": "artist",
            "playbackRate": 1.1,
            "keyShift": 1,
        },
    )
    assert denied.status_code == 403


def test_room_seek_is_authoritative_for_every_participant(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host"},
    ).json()

    sought = client.post(
        f"/rooms/{room['roomId']}/control",
        json={"participantId": "host", "command": "Seek", "positionSeconds": 42.5},
    )

    assert sought.status_code == 200
    assert sought.json()["playbackPositionSeconds"] == 42.5


def test_room_resume_keeps_the_paused_position(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host"},
    ).json()
    room_id = room["roomId"]
    client.post(
        f"/rooms/{room_id}/song",
        json={"participantId": "host", "songId": "song", "revision": 1},
    )
    client.post(
        f"/rooms/{room_id}/readiness",
        json={"participantId": "host", "readiness": "Ready"},
    )
    client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Start"},
    )
    client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Seek", "positionSeconds": 42.5},
    )
    client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Pause"},
    )

    resumed = client.post(
        f"/rooms/{room_id}/control",
        json={"participantId": "host", "command": "Start"},
    )

    assert resumed.status_code == 200
    assert resumed.json()["playbackPositionSeconds"] >= 42.5


def test_room_library_contains_ready_songs_published_by_every_member(client) -> None:
    room = client.post(
        "/rooms",
        json={"participantId": "host", "displayName": "Host"},
    ).json()
    room_id = room["roomId"]
    client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": "guest", "displayName": "Guest"},
    )
    for participant, song_id, title in (
        ("host", "song-host", "Host song"),
        ("guest", "song-guest", "Guest song"),
    ):
        response = client.post(
            f"/rooms/{room_id}/library",
            json={
                "participantId": participant,
                "songs": [{
                    "songId": song_id,
                    "revision": 1,
                    "title": title,
                    "artist": participant,
                    "album": None,
                    "genre": None,
                    "durationSeconds": 120,
                }],
            },
        )
        assert response.status_code == 200

    songs = client.get(f"/rooms/{room_id}").json()["sharedSongs"]
    assert {(song["ownerParticipantId"], song["songId"]) for song in songs} == {
        ("host", "song-host"),
        ("guest", "song-guest"),
    }


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
