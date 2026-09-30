from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi.testclient import TestClient

from backend.api.room_server_app import create_room_server_app
from backend.infrastructure.observable_rooms import ObservableRoomRepository
from backend.infrastructure.room_departures import RoomDepartures
from backend.infrastructure.room_project_folders import RoomProjectFolders


def test_a_closed_room_takes_its_uploaded_songs_with_it(tmp_path: Path) -> None:
    with TestClient(create_room_server_app(relay_port=0, project_root=tmp_path)) as client:
        room_id = client.post(
            "/rooms", json={"participantId": "host", "displayName": "Host"}
        ).json()["roomId"]
        folder = tmp_path / room_id
        folder.mkdir()
        (folder / "song-r1.advoice.zip").write_bytes(b"archive")
        closed = client.post(f"/rooms/{room_id}/close", json={"participantId": "host"})

    assert closed.status_code == 204
    assert not folder.exists()


def test_songs_of_rooms_that_no_longer_exist_are_swept_away(tmp_path: Path) -> None:
    for room in ("gone", "alive"):
        (tmp_path / room).mkdir()
        (tmp_path / room / "song-r1.advoice.zip").write_bytes(b"archive")

    RoomProjectFolders(tmp_path).remove_orphans(lambda: ("alive",))

    assert sorted(path.name for path in tmp_path.iterdir()) == ["alive"]


def test_an_app_closed_without_leaving_is_taken_out_and_its_empty_room_closes() -> None:
    app = create_room_server_app(relay_port=0, departure_grace_seconds=0)
    with TestClient(app) as client:
        room_id = client.post(
            "/rooms", json={"participantId": "host-seat", "displayName": "Host"}
        ).json()["roomId"]
        rooms: ObservableRoomRepository = app.state.container.rooms_repository
        with client.websocket_connect("/social/socket") as socket:
            socket.send_json(
                {
                    "device": "d" * 40,
                    "displayName": "Host",
                    "participantId": "host-seat",
                    "roomId": room_id,
                }
            )
            socket.receive_json()
            version = rooms.version(room_id)
        # The app is gone: its departure is the next change of the room.
        rooms.wait_for_change(room_id, version, timeout=10)
        room = client.get(f"/rooms/{room_id}")

    assert room.status_code == 404


def test_only_the_latest_departure_counts_and_a_returning_app_keeps_its_place() -> None:
    left: list[tuple[str, str]] = []
    online = {"anna": False}

    async def scenario() -> None:
        graces: asyncio.Queue[asyncio.Event] = asyncio.Queue()

        async def wait(_: float) -> None:
            grace = asyncio.Event()
            await graces.put(grace)
            await grace.wait()

        departures = RoomDepartures(
            lambda room, seat: left.append((room, seat)), lambda account: online[account], 60, wait
        )
        departures.gone("anna", "seat", "room")
        departures.gone("anna", "seat", "room")  # reconnected and went away again
        for _ in range(2):
            (await graces.get()).set()
        await departures.settled()
        online["anna"] = True
        departures.gone("anna", "seat", "room")
        (await graces.get()).set()
        await departures.settled()

    asyncio.run(scenario())
    # One departure took the seat: the earlier one no longer counted, the returning app kept it.
    assert left == [("room", "seat")]
