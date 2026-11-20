import asyncio
from dataclasses import replace
from threading import Lock

import anyio
import httpx
import pytest
from fastapi import FastAPI

from backend.api.room_server_app import _add_change_route
from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.infrastructure.observable_rooms import ObservableRoomRepository
from tests.test_room_snapshot_repository import _candidate


def _read_barrier(inner, expected, monkeypatch):
    reached, guard = asyncio.Event(), Lock()
    loop, read = asyncio.get_running_loop(), inner.get
    count = 0

    def observed(room_id):
        nonlocal count
        value = read(room_id)
        with guard:
            count += 1
            if count == expected:
                loop.call_soon_threadsafe(reached.set)
        return value

    monkeypatch.setattr(inner, "get", observed)
    return reached


def _app(repository):
    app = FastAPI()
    _add_change_route(app, repository)

    @app.get("/probe")
    def probe():
        # Ordinary health/control routes share this same FastAPI worker pool.
        return {"responsive": True}

    return app


@pytest.mark.asyncio
@pytest.mark.parametrize("tokens", [2, 40])
async def test_idle_room_long_polls_leave_workers_for_control_routes(monkeypatch, tokens):
    inner = InMemoryRoomRepository()
    repository = ObservableRoomRepository(inner)
    room = repository.save(_candidate())
    entered = _read_barrier(inner, tokens * 2, monkeypatch)
    limiter = anyio.to_thread.current_default_thread_limiter()
    original_tokens, limiter.total_tokens = limiter.total_tokens, tokens
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(_app(repository)), base_url="http://test"
    ) as client:
        pending = [
            asyncio.create_task(
                client.get(
                    "/rooms/room/changes",
                    params={"participantId": "host", "after": repository.version("room")},
                )
            )
            for _ in range(tokens)
        ]
        response = None
        try:
            await asyncio.wait_for(entered.wait(), timeout=2)
            try:
                response = await asyncio.wait_for(client.get("/probe"), timeout=0.3)
            except TimeoutError:
                pass
        finally:
            await asyncio.to_thread(repository.save, replace(room, library_query="release"))
            finished = await asyncio.wait_for(asyncio.gather(*pending), timeout=3)
            limiter.total_tokens = original_tokens
    assert all(result.status_code == 200 for result in finished)
    assert response is not None, "Idle room watches exhausted the workers used by control requests"
    assert response.json() == {"responsive": True}
