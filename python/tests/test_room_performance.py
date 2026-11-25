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


@pytest.mark.parametrize(
    "contributions,expected",
    [
        ([("host", 100, 10), ("guest", 50, 1)], 1050 / 11),
        ([("host", 100, 10), ("guest", 50, 10), ("third", 0, 1)], 1500 / 21),
        ([("host", 100, 4), ("guest", 80, 3), ("third", 60, 2), ("fourth", 40, 1)], 80),
    ],
)
def test_group_score_weights_each_singers_actual_contribution(duet, contributions, expected):
    client, code, room = duet
    for participant, accuracy, seconds in contributions:
        if participant not in ("host", "guest"):
            joined = client.post(
                f"/rooms/{code}/join",
                json={"participantId": participant, "displayName": participant},
            )
            assert joined.status_code == 200
        assert report(client, code, room, participant, accuracy, seconds).status_code == 204
    assert client.get(f"/rooms/{code}").json()["performanceAccuracy"] == pytest.approx(expected)


def test_both_singers_matter_in_a_shared_chorus(duet):
    client, code, room = duet
    report(client, code, room, "host", 80, 10)
    report(client, code, room, "guest", 40, 10)
    assert client.get(f"/rooms/{code}").json()["performanceAccuracy"] == 60


def test_room_vocal_sources_are_separate_and_owned_by_each_singer(duet):
    client, code, room = duet
    base = f"/rooms/{code}/performances/{room['performanceId']}/sources"
    for singer, audio in (("host", b"host-lossless-source"), ("guest", b"guest-lossless-source")):
        uploaded = client.put(
            f"{base}/{singer}", content=audio, headers={"X-Participant-Id": singer}
        )
        assert uploaded.status_code == 204, uploaded.text
        downloaded = client.get(f"{base}/{singer}", headers={"X-Participant-Id": "host"})
        assert downloaded.status_code == 200 and downloaded.content == audio
    assert (
        client.put(
            f"{base}/guest", content=b"overwrite", headers={"X-Participant-Id": "host"}
        ).status_code
        == 403
    )
    assert client.get(f"{base}/host", headers={"X-Participant-Id": "outsider"}).status_code == 403
    assert (
        client.put(f"{base}/host", content=b"", headers={"X-Participant-Id": "host"}).status_code
        == 204
    )
    assert (
        client.get(f"{base}/host", headers={"X-Participant-Id": "host"}).content
        == b"host-lossless-source"
    )
    manifest = client.get(base, headers={"X-Participant-Id": "guest"})
    assert manifest.status_code == 200, manifest.text
    assert manifest.json() == {
        "complete": False,
        "participants": [
            {"participantId": singer, "available": True, "sizeBytes": len(audio)}
            for singer, audio in (
                ("guest", b"guest-lossless-source"),
                ("host", b"host-lossless-source"),
            )
        ],
    }


def test_new_song_discards_previous_scores_and_rejects_delayed_report(duet):
    client, code, room = duet
    report(client, code, room, "host", 100, 10)
    selected = client.post(
        f"/rooms/{code}/song", json={"participantId": "host", "songId": "next", "revision": 1}
    ).json()
    assert selected["performanceId"] != room["performanceId"]
    assert selected["performanceAccuracy"] is None
    assert report(client, code, room, "host", 100, 11).status_code == 409


def test_finished_performance_sources_exclude_later_joiners_and_mark_silent_singers(duet):
    client, code, room = duet
    base = f"/rooms/{code}/performances/{room['performanceId']}/sources"
    host = {"X-Participant-Id": "host"}
    assert client.put(f"{base}/host", content=b"", headers=host).status_code == 204
    manifest = client.get(base, headers=host).json()["participants"]
    assert manifest == [
        {"participantId": "guest", "available": False, "sizeBytes": 0},
        {"participantId": "host", "available": True, "sizeBytes": 0},
    ]
    report(client, code, room, "host", 80, 1)
    client.post(
        f"/rooms/{code}/song", json={"participantId": "host", "songId": "next", "revision": 1}
    )
    client.post(f"/rooms/{code}/join", json={"participantId": "later", "displayName": "Later"})
    assert client.get(base, headers=host).json()["participants"] == manifest
    assert client.get(base, headers={"X-Participant-Id": "later"}).status_code == 403
    assert client.get(f"{base}/host", headers=host).content == b""


@pytest.mark.parametrize("accuracy,seconds", [(101, 1), (-1, 1), (50, -1)])
def test_invalid_scores_are_rejected(duet, accuracy, seconds):
    client, code, room = duet
    assert report(client, code, room, "host", accuracy, seconds).status_code == 422


def test_singer_sources_retain_every_capture_and_wait_for_an_open_reconnection(duet):
    client, code, room = duet
    base = f"/rooms/{code}/performances/{room['performanceId']}/sources"
    headers = {"X-Participant-Id": "host"}
    first = "887c7a1f-1e2b-4edf-82ab-91efc72c3be3"
    second = "d4d1e9b2-b32a-44b9-8562-08b8b246e6e5"
    path = f"{base}/host/captures"
    assert client.post(f"{path}/{first}", headers=headers).status_code == 204
    assert client.put(f"{path}/{first}", content=b"first", headers=headers).status_code == 204
    assert client.post(f"{path}/{second}", headers=headers).status_code == 204
    sources = client.get(base, headers=headers).json()
    host = next(item for item in sources["participants"] if item["participantId"] == "host")
    assert not host["available"]
    assert len(host["captures"]) == 2
    assert client.get(f"{path}/{first}", headers=headers).content == b"first"
    assert client.get(f"{path}/{second}", headers=headers).status_code == 404
    assert client.put(f"{path}/{second}", content=b"second", headers=headers).status_code == 204
    host = next(
        item
        for item in client.get(base, headers=headers).json()["participants"]
        if item["participantId"] == "host"
    )
    assert host["available"]
    assert sum(item["sizeBytes"] for item in host["captures"]) == 11
    assert client.get(f"{path}/{first}", headers={"X-Participant-Id": "guest"}).content == b"first"
    assert client.post(f"{path}/{first}", headers={"X-Participant-Id": "guest"}).status_code == 403
    assert client.get(f"{path}/../source", headers=headers).status_code != 200


def test_singer_sources_finish_after_room_closure_without_becoming_public(duet):
    client, code, room = duet
    base = f"/rooms/{code}/performances/{room['performanceId']}/sources"
    headers = {"X-Participant-Id": "host"}
    capture = "887c7a1f-1e2b-4edf-82ab-91efc72c3be3"
    path = f"{base}/host/captures/{capture}"
    assert client.post(path, headers=headers).status_code == 204
    assert client.post(f"/rooms/{code}/close", json={"participantId": "host"}).status_code == 204
    assert client.put(path, content=b"finished voice", headers=headers).status_code == 204
    manifest = client.get(base, headers=headers)
    assert manifest.status_code == 200, manifest.text
    assert manifest.json()["complete"]
    assert client.get(path, headers={"X-Participant-Id": "guest"}).content == b"finished voice"
    assert client.get(path, headers={"X-Participant-Id": "outsider"}).status_code == 403


def test_non_member_cannot_submit_a_score(duet):
    client, code, room = duet
    assert report(client, code, room, "outsider", 100, 10).status_code == 403


def test_zero_sung_duration_keeps_the_group_unassessed(duet):
    client, code, room = duet
    assert report(client, code, room, "host", 100, 0).status_code == 204
    assert client.get(f"/rooms/{code}").json()["performanceAccuracy"] is None


@pytest.mark.parametrize("transition", ["none", "clear", "next-song"])
def test_final_group_result_waits_for_both_singers_and_survives_clear(duet, transition):
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
            if transition != "none":
                assert (
                    client.post(
                        f"/rooms/{code}/song/clear", json={"participantId": "host"}
                    ).status_code
                    == 200
                )
            if transition == "next-song":
                assert (
                    client.post(
                        f"/rooms/{code}/song",
                        json={"participantId": "host", "songId": "next", "revision": 1},
                    ).status_code
                    == 200
                )
    assert snapshot["performanceResults"][str(room["performanceId"])] == {
        "complete": True,
        "score": 80,
    }
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
