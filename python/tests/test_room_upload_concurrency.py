from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from starlette.requests import Request
import anyio
from fastapi.testclient import TestClient
from backend.api.room_server_app import create_room_server_app

from backend.api.room_project_routes import store_project


def test_waiting_singer_sees_complete_upload_size_including_video(tmp_path, monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()

    async def held_upload(request, target, on_progress=None):
        content = await request.body()
        if on_progress:
            on_progress(len(content) // 2)
        started.set()
        assert await anyio.to_thread.run_sync(release.wait, 5)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

    monkeypatch.setattr("backend.api.room_project_routes.store_project", held_upload)
    with TestClient(create_room_server_app(relay_port=0, project_root=tmp_path)) as client:
        room_id = client.post(
            "/rooms", json={"participantId": "host", "displayName": "Host"}
        ).json()["roomId"]
        client.post(
            f"/rooms/{room_id}/join", json={"participantId": "guest", "displayName": "Guest"}
        )
        client.post(
            f"/rooms/{room_id}/library",
            json={
                "participantId": "host",
                "songs": [
                    {
                        "songId": "song",
                        "revision": 1,
                        "title": "Song",
                        "artist": "Singer",
                        "durationSeconds": 10,
                    },
                ],
            },
        )
        path = f"/rooms/{room_id}/projects/song/1"
        data = b"audio-and-full-video-clip"
        with ThreadPoolExecutor(max_workers=1) as pool:
            upload = pool.submit(
                client.put, path, content=data, headers={"X-Participant-Id": "host"}
            )
            try:
                assert started.wait(5)
                pending = client.get(path, headers={"X-Participant-Id": "guest"})
                assert pending.status_code == 404
                assert pending.json()["details"] == {
                    "uploadBytes": len(data) // 2,
                    "uploadTotalBytes": len(data),
                }
            finally:
                release.set()
            assert upload.result().status_code == 204
        assert client.get(path, headers={"X-Participant-Id": "guest"}).content == data


def test_room_upload_retry_cannot_truncate_or_delete_another_upload(tmp_path: Path) -> None:
    async def scenario() -> None:
        target = tmp_path / "project.zip"
        first_started = asyncio.Event()
        finish_first = asyncio.Event()
        step = 0

        async def first_receive() -> dict:
            nonlocal step
            step += 1
            if step == 1:
                return {"type": "http.request", "body": b"first-", "more_body": True}
            first_started.set()
            await finish_first.wait()
            return {"type": "http.request", "body": b"complete", "more_body": False}

        async def second_receive() -> dict:
            return {"type": "http.request", "body": b"second-complete", "more_body": False}

        first = asyncio.create_task(store_project(Request({"type": "http"}, first_receive), target))
        await first_started.wait()
        try:
            await store_project(Request({"type": "http"}, second_receive), target)
        finally:
            finish_first.set()
        results = await asyncio.gather(first, return_exceptions=True)
        assert results == [None]
        assert target.read_bytes() == b"first-complete"
        assert list(tmp_path.iterdir()) == [target]

    asyncio.run(scenario())
