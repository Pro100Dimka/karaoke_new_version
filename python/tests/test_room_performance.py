from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api.room_server_app import create_room_server_app


@pytest.fixture
def duet(tmp_path):
    app = create_room_server_app(
        relay_port=0,
        room_database=tmp_path / "rooms.sqlite3",
        project_root=tmp_path / "projects",
        diagnostics_root=tmp_path / "diagnostics",
    )
    with TestClient(app) as client:
        room = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()
        code = room["roomId"]
        client.post(f"/rooms/{code}/join", json={"participantId": "guest", "displayName": "Guest"})
        selected = client.post(
            f"/rooms/{code}/song", json={"participantId": "host", "songId": "song", "revision": 1}
        ).json()
        yield client, code, selected


def report(client, code, room, participant, accuracy, seconds):
    return client.post(
        f"/rooms/{code}/performance",
        json={
            "participantId": participant,
            "performanceId": room["performanceId"],
            "accuracy": accuracy,
            "sungSeconds": seconds,
        },
    )


def test_silent_duet_partner_does_not_reduce_group_score(duet):
    client, code, room = duet
    assert report(client, code, room, "host", 90, 10).status_code == 204
    snapshot = client.get(f"/rooms/{code}").json()
    assert snapshot["performanceAccuracy"] == 90
    assert (
        next(p for p in snapshot["participants"] if p["participantId"] == "guest")[
            "performanceAccuracy"
        ]
        is None
    )


def test_group_score_weights_each_singers_actual_contribution(duet):
    client, code, room = duet
    assert report(client, code, room, "host", 100, 10).status_code == 204
    assert report(client, code, room, "guest", 50, 1).status_code == 204
    assert client.get(f"/rooms/{code}").json()["performanceAccuracy"] == pytest.approx(1050 / 11)


def test_both_singers_matter_in_a_shared_chorus(duet):
    client, code, room = duet
    report(client, code, room, "host", 80, 10)
    report(client, code, room, "guest", 40, 10)
    assert client.get(f"/rooms/{code}").json()["performanceAccuracy"] == 60


def test_new_song_discards_previous_scores_and_rejects_delayed_report(duet):
    client, code, room = duet
    report(client, code, room, "host", 100, 10)
    selected = client.post(
        f"/rooms/{code}/song", json={"participantId": "host", "songId": "next", "revision": 1}
    ).json()
    assert selected["performanceId"] != room["performanceId"]
    assert selected["performanceAccuracy"] is None
    assert report(client, code, room, "host", 100, 11).status_code == 409


@pytest.mark.parametrize("accuracy,seconds", [(101, 1), (-1, 1), (50, -1)])
def test_invalid_scores_are_rejected(duet, accuracy, seconds):
    client, code, room = duet
    assert report(client, code, room, "host", accuracy, seconds).status_code == 422


def test_non_member_cannot_submit_a_score(duet):
    client, code, room = duet
    assert report(client, code, room, "outsider", 100, 10).status_code == 403


def test_zero_sung_duration_keeps_the_group_unassessed(duet):
    client, code, room = duet
    assert report(client, code, room, "host", 100, 0).status_code == 204
    assert client.get(f"/rooms/{code}").json()["performanceAccuracy"] is None


def test_final_group_result_waits_for_both_singers_and_survives_clear(duet):
    client, code, room = duet
    for participant, accuracy in (("host", 70), ("guest", 90)):
        response = client.post(
            f"/rooms/{code}/performance",
            json={
                "participantId": participant,
                "performanceId": room["performanceId"],
                "accuracy": accuracy,
                "sungSeconds": 10,
                "finished": True,
            },
        )
        assert response.status_code == 204
        snapshot = client.get(f"/rooms/{code}").json()
        if participant == "host":
            assert snapshot["lastPerformanceId"] is None
    assert snapshot["lastPerformanceAccuracy"] == 80
    cleared = client.post(f"/rooms/{code}/song/clear", json={"participantId": "host"})
    assert cleared.status_code == 200
    assert cleared.json()["lastPerformanceId"] == room["performanceId"]
    assert cleared.json()["lastPerformanceAccuracy"] == 80


def test_restart_resets_scores_but_pause_resume_preserves_them(duet):
    client, code, _ = duet
    for participant in ("host", "guest"):
        client.post(
            f"/rooms/{code}/readiness",
            json={
                "selectionId": client.get(
                    f"/rooms/{code}/readiness".removesuffix("/readiness")
                ).json()["selectionId"],
                "participantId": participant,
                "readiness": "Ready",
            },
        )
        client.post(
            f"/rooms/{code}/timing", json={"participantId": participant, "voiceLatencyMs": 20}
        )
    started = client.get(f"/rooms/{code}").json()
    assert report(client, code, started, "host", 80, 10).status_code == 204
    paused = client.post(
        f"/rooms/{code}/control", json={"participantId": "host", "command": "Pause"}
    ).json()
    assert paused["performanceId"] == started["performanceId"]
    assert paused["performanceAccuracy"] == 80
    resumed = client.post(
        f"/rooms/{code}/control", json={"participantId": "host", "command": "Start"}
    ).json()
    assert resumed["performanceId"] == started["performanceId"]
    restarted = client.post(
        f"/rooms/{code}/control", json={"participantId": "host", "command": "Start"}
    ).json()
    assert restarted["performanceId"] != started["performanceId"]
    assert restarted["performanceAccuracy"] is None
