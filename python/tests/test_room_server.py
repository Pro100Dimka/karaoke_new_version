from __future__ import annotations

from fastapi.testclient import TestClient

from backend.api.room_server_app import create_room_server_app


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
