from __future__ import annotations

import asyncio
from pathlib import Path

from starlette.requests import Request

from backend.api.room_server_app import _store_project


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

        first = asyncio.create_task(_store_project(Request({"type": "http"}, first_receive), target))
        await first_started.wait()
        try:
            await _store_project(Request({"type": "http"}, second_receive), target)
        finally:
            finish_first.set()
        results = await asyncio.gather(first, return_exceptions=True)
        assert results == [None]
        assert target.read_bytes() == b"first-complete"
        assert list(tmp_path.iterdir()) == [target]

    asyncio.run(scenario())
