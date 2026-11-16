from __future__ import annotations

import threading
from contextlib import AbstractContextManager

from fastapi.testclient import TestClient

import backend.room.commands as commands
from backend.api.room_server_app import create_room_server_app
from backend.room.serialization import RoomLocks

_READY_REPORTS = ("host", "g1", "g2")


def test_room_voice_settings_share_the_singers_values_without_resetting_them() -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        room_id = client.post(
            "/rooms", json={"participantId": "host", "displayName": "Host"}
        ).json()["roomId"]
        client.post(
            f"/rooms/{room_id}/join", json={"participantId": "guest", "displayName": "Guest"}
        )
        path = f"/rooms/{room_id}/voice-settings"
        settings = dict(
            echo=0.1, reverb=0.2, delay=0.3, autoTune=0.4, noiseSuppression=0.5, voiceGain=1.2
        )
        initial = client.post(
            path,
            json=dict(
                participantId="guest",
                targetParticipantId="guest",
                settings=settings,
                initialize=True,
            ),
        )
        assert initial.status_code == 200, initial.text
        changed = client.post(
            path,
            json=dict(participantId="host", targetParticipantId="guest", settings={"echo": 0.7}),
        )
        assert changed.status_code == 200, changed.text
        repeated = client.post(
            path,
            json=dict(
                participantId="guest",
                targetParticipantId="guest",
                settings=settings,
                initialize=True,
            ),
        )
        guest = next(p for p in repeated.json()["participants"] if p["participantId"] == "guest")
        assert guest["voiceSettings"] == {**settings, "echo": 0.7}
        assert guest["voiceSettingsRevision"] == 2
        assert (
            client.post(
                path,
                json=dict(
                    participantId="outsider", targetParticipantId="guest", settings={"echo": 0.1}
                ),
            ).status_code
            == 403
        )
        assert (
            client.post(
                path,
                json=dict(
                    participantId="host", targetParticipantId="guest", settings={"echo": 1.1}
                ),
            ).status_code
            == 422
        )
        assert (
            client.post(
                path,
                json=dict(
                    participantId="host", targetParticipantId="guest", settings={"unknown": 1}
                ),
            ).status_code
            == 422
        )


def test_concurrent_readiness_reports_are_never_lost(monkeypatch) -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        room_id = client.post(
            "/rooms", json={"participantId": "host", "displayName": "Host"}
        ).json()["roomId"]
        for guest in ("g1", "g2"):
            client.post(
                f"/rooms/{room_id}/join", json={"participantId": guest, "displayName": guest}
            )
        client.post(
            f"/rooms/{room_id}/song",
            json={"participantId": "host", "songId": "song", "revision": 1},
        )
        # Every report reads the room and then waits until all three reports have reached the
        # room's lock. Without the lock all three would read the same room and two saves would be
        # lost; with it, the others wait at the lock and read the room the first one saved.
        arrived = 0
        arrival_lock = threading.Lock()
        all_arrived = threading.Event()
        original_hold = RoomLocks.hold
        original_member_room = commands.member_room

        def counting_hold(self: RoomLocks, room: str) -> AbstractContextManager[None]:
            nonlocal arrived
            with arrival_lock:
                arrived += 1
                if arrived == len(_READY_REPORTS):
                    all_arrived.set()
            return original_hold(self, room)

        def contended_member_room(*args: object, **kwargs: object):  # type: ignore[no-untyped-def]
            room = original_member_room(*args, **kwargs)  # type: ignore[arg-type]
            all_arrived.wait()
            return room

        monkeypatch.setattr(RoomLocks, "hold", counting_hold)
        monkeypatch.setattr(commands, "member_room", contended_member_room)

        def ready(participant_id: str) -> None:
            client.post(
                f"/rooms/{room_id}/readiness",
                json={
                    "selectionId": client.get(
                        f"/rooms/{room_id}/readiness".removesuffix("/readiness")
                    ).json()["selectionId"],
                    "participantId": participant_id,
                    "readiness": "Ready",
                },
            )

        threads = [threading.Thread(target=ready, args=(p,)) for p in _READY_REPORTS]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        room = client.get(f"/rooms/{room_id}").json()

    assert {p["participantId"]: p["readinessState"] for p in room["participants"]} == {
        participant: "Ready" for participant in _READY_REPORTS
    }
