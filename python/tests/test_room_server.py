from __future__ import annotations

import subprocess
import sys
from fastapi.testclient import TestClient
from concurrent.futures import ThreadPoolExecutor

from backend.api.room_server_app import create_room_server_app


def test_room_server_import_does_not_require_desktop_ai_dependencies() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; "
                "sys.modules['numpy'] = None; "
                "from backend.api.room_server_app import create_room_server_app; "
                "assert create_room_server_app(relay_port=0).title"
            ),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_room_server_exposes_the_shared_room_flow_between_two_participants() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        created = client.post("/rooms", json={"participantId": "host-1", "displayName": "Host"})
        assert created.status_code == 201
        code = created.json()["roomId"]

        joined = client.post(
            f"/rooms/{code}/join", json={"participantId": "guest-1", "displayName": "Guest"}
        )
        assert joined.status_code == 200
        assert [item["participantId"] for item in joined.json()["participants"]] == [
            "host-1",
            "guest-1",
        ]

        fetched = client.get(f"/rooms/{code}")
        assert fetched.status_code == 200
        assert len(fetched.json()["participants"]) == 2


def test_room_code_is_case_insensitive_when_joining_from_the_desktop_form() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        created = client.post("/rooms", json={"participantId": "host-1", "displayName": "Host"})
        code = created.json()["roomId"]

        joined = client.post(
            f"/rooms/{code.upper()}/join",
            json={"participantId": "guest-1", "displayName": "Guest"},
        )

        assert joined.status_code == 200
        assert joined.json()["roomId"] == code


def test_a_room_created_here_is_not_visible_to_a_second_independent_server() -> None:
    with (
        TestClient(create_room_server_app(relay_port=0)) as first,
        TestClient(create_room_server_app(relay_port=0)) as second,
    ):
        created = first.post("/rooms", json={"participantId": "host-1", "displayName": "Host"})
        code = created.json()["roomId"]

        missing = second.get(f"/rooms/{code}")

        assert missing.status_code == 404
        assert missing.json()["code"] == "RoomNotFound"


def test_room_survives_server_restart_with_shared_database(tmp_path) -> None:
    database = tmp_path / "rooms.sqlite3"
    with TestClient(create_room_server_app(relay_port=0, room_database=database)) as first:
        created = first.post("/rooms", json={"participantId": "host-1", "displayName": "Host"})
        code = created.json()["roomId"]

    with TestClient(create_room_server_app(relay_port=0, room_database=database)) as restarted:
        restored = restarted.get(f"/rooms/{code}")

    assert restored.status_code == 200
    assert restored.json()["hostId"] == "host-1"


def test_health_endpoint_reports_ready() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        response = client.get("/health/ready")
        assert response.status_code == 200
        assert response.json() == {"ok": True}


def test_voice_join_requires_an_actual_room_member() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        created = client.post("/rooms", json={"participantId": "host", "displayName": "Host"})
        room_id = created.json()["roomId"]

        stranger = client.post("/voice/join", json={"roomId": room_id, "participantId": "stranger"})
        member = client.post("/voice/join", json={"roomId": room_id, "participantId": "host"})

        assert stranger.status_code == 404
        assert stranger.json()["code"] == "ParticipantNotFound"
        assert member.status_code == 200
        assert len(member.json()["voiceToken"]) == 16


def test_room_project_can_be_uploaded_by_owner_and_downloaded_by_member(tmp_path) -> None:
    with TestClient(
        create_room_server_app(relay_port=0, project_root=tmp_path / "projects")
    ) as client:
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
                "participantId": "host",
                "songs": [{
                    "songId": "song-1",
                    "revision": 2,
                    "title": "Song",
                    "artist": "Artist",
                    "durationSeconds": 100,
                }],
            },
        )

        uploaded = client.put(
            f"/rooms/{room_id}/projects/song-1/2",
            content=b"package-bytes",
            headers={"X-Participant-Id": "host"},
        )
        downloaded = client.get(
            f"/rooms/{room_id}/projects/song-1/2",
            headers={"X-Participant-Id": "guest"},
        )

        assert uploaded.status_code == 204
        assert downloaded.status_code == 200
        assert downloaded.content == b"package-bytes"


def test_room_changes_waits_and_pushes_the_next_room_snapshot() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        created = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()
        room_id = created["roomId"]
        initial = client.get(
            f"/rooms/{room_id}/changes",
            params={"participantId": "host", "after": 0},
        ).json()

        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(
                client.get,
                f"/rooms/{room_id}/changes",
                params={"participantId": "host", "after": initial["version"]},
            )
            client.post(
                f"/rooms/{room_id}/join",
                json={"participantId": "guest", "displayName": "Guest"},
            )
            changed = pending.result(timeout=2)

        assert changed.status_code == 200
        assert changed.json()["version"] > initial["version"]
        assert [item["participantId"] for item in changed.json()["room"]["participants"]] == [
            "host", "guest"
        ]
