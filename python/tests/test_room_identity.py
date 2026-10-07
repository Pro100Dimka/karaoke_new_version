from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api.room_identity import ROOM_KEY_HEADER, participant_id_for
from backend.api.room_server_app import create_room_server_app
from backend.room.serialization import _room_locks, room_lock

pytestmark = pytest.mark.real_room_keys

HOST_KEY = "h" * 64
GUEST_KEY = "g" * 64
ATTACKER_KEY = "a" * 64
HOST = participant_id_for(HOST_KEY)
GUEST = participant_id_for(GUEST_KEY)


def as_(key: str) -> dict[str, str]:
    return {ROOM_KEY_HEADER: key}


def room_with_guest(client: TestClient) -> str:
    room_id = client.post(
        "/rooms", json={"participantId": HOST, "displayName": "Host"}, headers=as_(HOST_KEY)
    ).json()["roomId"]
    joined = client.post(
        f"/rooms/{room_id}/join",
        json={"participantId": GUEST, "displayName": "Guest"},
        headers=as_(GUEST_KEY),
    )
    assert joined.status_code == 200, joined.text
    return room_id


def test_knowing_the_host_id_is_not_enough_to_act_as_the_host() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        room_id = room_with_guest(client)
        for path, body in (
            (f"/rooms/{room_id}/close", {"participantId": HOST}),
            (f"/rooms/{room_id}/host", {"participantId": HOST, "targetParticipantId": GUEST}),
            (f"/rooms/{room_id}/join", {"participantId": HOST, "displayName": "Anything"}),
            ("/voice/join", {"roomId": room_id, "participantId": HOST, "machineId": "attacker"}),
        ):
            for headers in ({}, as_(ATTACKER_KEY), as_(GUEST_KEY)):
                forged = client.post(path, json=body, headers=headers)
                assert forged.status_code == 403, (path, headers, forged.text)
                assert forged.json()["code"] == "RoomIdentityInvalid"
        room = client.get(f"/rooms/{room_id}").json()

    assert room["hostId"] == HOST
    assert {p["participantId"]: p["displayName"] for p in room["participants"]} == {
        HOST: "Host",
        GUEST: "Guest",
    }


def test_project_downloads_and_room_watching_need_the_participant_key() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        room_id = room_with_guest(client)
        download = client.get(
            f"/rooms/{room_id}/projects/song/1",
            headers={"X-Participant-Id": GUEST, **as_(ATTACKER_KEY)},
        )
        watch = client.get(f"/rooms/{room_id}/changes", params={"participantId": GUEST})

    assert download.status_code == 403
    assert watch.status_code == 403


def test_the_real_host_still_reconnects_and_controls_the_room() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        room_id = room_with_guest(client)
        client.post(f"/rooms/{room_id}/disconnect", json={"participantId": HOST}, headers=as_(HOST_KEY))
        rejoined = client.post(
            f"/rooms/{room_id}/join",
            json={"participantId": HOST, "displayName": "Host"},
            headers=as_(HOST_KEY),
        )
        closed = client.post(f"/rooms/{room_id}/close", json={"participantId": HOST}, headers=as_(HOST_KEY))

    assert rejoined.status_code == 200
    assert rejoined.json()["hostId"] == HOST
    assert closed.status_code == 204


def test_a_disconnected_participant_cannot_change_its_readiness() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        room_id = room_with_guest(client)
        client.post(f"/rooms/{room_id}/disconnect", json={"participantId": GUEST}, headers=as_(GUEST_KEY))
        update = client.post(
            f"/rooms/{room_id}/readiness",
            json={"participantId": GUEST, "readiness": "Ready"},
            headers=as_(GUEST_KEY),
        )

    assert update.status_code == 403
    assert update.json()["code"] == "RoomPermissionDenied"


def test_room_locks_do_not_outlive_their_use() -> None:
    for number in range(1000):
        with room_lock(f"room-{number}"), room_lock(f"room-{number}"):
            pass

    assert _room_locks == {}


def _host_close_forms(room_id: str) -> list[dict[str, object]]:
    """Every way a body can name the host that FastAPI would still parse into the close command."""
    body = f'{{"participantId": "{HOST}"}}'.encode()
    return [
        {"content": body, "headers": {"content-type": "application/vnd.api+json"}},
        {"content": body, "headers": {"content-type": "Application/JSON"}},
        {"content": body, "headers": {"content-type": " application/json"}},
        {"content": body, "headers": {}},
        {"json": {"participant_id": HOST}},
        {"json": {"participantId": GUEST, "participant_id": HOST}, "headers": as_(GUEST_KEY)},
        {"json": {"participantId": HOST}, "headers": {**as_(GUEST_KEY), "X-Participant-Id": GUEST}},
    ]


def test_no_body_encoding_lets_a_request_close_the_room_without_the_hosts_key() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        room_id = room_with_guest(client)
        for form in _host_close_forms(room_id):
            forged = client.post(f"/rooms/{room_id}/close", **form)  # type: ignore[arg-type]
            assert forged.status_code == 403, (form, forged.status_code, forged.text)
        survived = client.get(f"/rooms/{room_id}")

    assert survived.status_code == 200


def test_a_participant_id_header_cannot_be_repeated_to_borrow_another_identity() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        room_id = room_with_guest(client)
        forged = client.get(
            f"/rooms/{room_id}/projects/song/1",
            headers=[("X-Participant-Id", GUEST), ("X-Participant-Id", HOST), (ROOM_KEY_HEADER, GUEST_KEY)],
        )

    assert forged.status_code == 403
    assert forged.json()["code"] == "RoomIdentityInvalid"


def _share(client: TestClient, room_id: str, participant: str, key: str) -> None:
    shared = client.post(
        f"/rooms/{room_id}/library",
        json={
            "participantId": participant,
            "songs": [{"songId": "song-1", "revision": 1, "title": "Song", "artist": "A", "durationSeconds": 1}],
        },
        headers=as_(key),
    )
    assert shared.status_code == 200, shared.text


def test_a_guest_sharing_a_copy_cannot_replace_the_hosts_room_project(tmp_path) -> None:
    with TestClient(create_room_server_app(relay_port=0, project_root=tmp_path)) as client:
        room_id = room_with_guest(client)
        _share(client, room_id, HOST, HOST_KEY)
        original = client.put(
            f"/rooms/{room_id}/projects/song-1/1",
            content=b"HOST_PROJECT",
            headers={"X-Participant-Id": HOST, **as_(HOST_KEY)},
        )
        _share(client, room_id, GUEST, GUEST_KEY)
        replacement = client.put(
            f"/rooms/{room_id}/projects/song-1/1",
            content=b"GUEST_REPLACEMENT",
            headers={"X-Participant-Id": GUEST, **as_(GUEST_KEY)},
        )
        downloaded = client.get(
            f"/rooms/{room_id}/projects/song-1/1",
            headers={"X-Participant-Id": GUEST, **as_(GUEST_KEY)},
        )
        _share(client, room_id, HOST, HOST_KEY)  # republishing never lets the copy move ahead
        owners = [
            song["ownerParticipantId"]
            for song in client.get(f"/rooms/{room_id}").json()["sharedSongs"]
        ]

    assert original.status_code == 204
    assert replacement.status_code == 403
    assert downloaded.content == b"HOST_PROJECT"
    assert owners == [HOST, GUEST]
