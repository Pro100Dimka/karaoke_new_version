from __future__ import annotations

import threading
import time

from fastapi.testclient import TestClient

import backend.room.commands as commands
from backend.api.room_server_app import create_room_server_app


def test_concurrent_readiness_reports_are_never_lost(monkeypatch) -> None:
    # A loaded server: every command spends a moment between reading the room and saving it.
    original = commands.load_room

    def slow_load(*args, **kwargs):
        room = original(*args, **kwargs)
        time.sleep(0.05)
        return room

    monkeypatch.setattr(commands, "load_room", slow_load)
    with TestClient(create_room_server_app(relay_port=0)) as client:
        room_id = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()[
            "roomId"
        ]
        for guest in ("g1", "g2"):
            client.post(f"/rooms/{room_id}/join", json={"participantId": guest, "displayName": guest})
        client.post(
            f"/rooms/{room_id}/song",
            json={"participantId": "host", "songId": "song", "revision": 1},
        )
        barrier = threading.Barrier(3)

        def ready(participant_id: str) -> None:
            barrier.wait()
            client.post(
                f"/rooms/{room_id}/readiness",
                json={"participantId": participant_id, "readiness": "Ready"},
            )

        threads = [threading.Thread(target=ready, args=(p,)) for p in ("host", "g1", "g2")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        room = client.get(f"/rooms/{room_id}").json()

    assert {p["participantId"]: p["readinessState"] for p in room["participants"]} == {
        "host": "Ready",
        "g1": "Ready",
        "g2": "Ready",
    }
