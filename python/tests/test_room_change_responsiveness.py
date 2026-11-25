import asyncio
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from dataclasses import replace
from threading import Event, Lock

import anyio
import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from backend.api import room_server_app
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


@pytest.mark.parametrize("stage", ["snapshot-mapping", "json-encoding"])
def test_room_snapshot_response_does_not_block_control_requests(monkeypatch, stage):
    repository = ObservableRoomRepository(InMemoryRoomRepository())
    room = repository.save(_candidate("shared library"))
    entered, release = Event(), Event()

    def hold_snapshot_work():
        entered.set()
        assert release.wait(5)

    if stage == "snapshot-mapping":
        original_room = room_server_app._room

        def slow_room(snapshot):
            hold_snapshot_work()
            return original_room(snapshot)

        monkeypatch.setattr(room_server_app, "_room", slow_room)
    else:
        original_render = JSONResponse.render
        original_dump_json = TypeAdapter.dump_json

        def hold_snapshot_encoding(content):
            if isinstance(content, dict) and "room" in content and "version" in content:
                hold_snapshot_work()

        def slow_render(response, content):
            hold_snapshot_encoding(content)
            return original_render(response, content)

        def slow_dump_json(adapter, content, **kwargs):
            hold_snapshot_encoding(content)
            return original_dump_json(adapter, content, **kwargs)

        # FastAPI can encode response models directly or render an explicit JSONResponse.
        monkeypatch.setattr(JSONResponse, "render", slow_render)
        monkeypatch.setattr(TypeAdapter, "dump_json", slow_dump_json)

    with TestClient(_app(repository)) as client, ThreadPoolExecutor(max_workers=2) as callers:
        watch = callers.submit(
            client.get, "/rooms/room/changes", params={"participantId": "host", "after": 0}
        )
        response = None
        try:
            assert entered.wait(2), (
                "The room snapshot did not reach the injected serialization delay"
            )
            probe = callers.submit(client.get, "/probe")
            try:
                response = probe.result(timeout=0.3)
            except TimeoutError:
                pass
        finally:
            release.set()
        snapshot = watch.result(timeout=2)

    assert response is not None, f"{stage} blocked other requests on the room event loop"
    assert response.json() == {"responsive": True}
    assert snapshot.status_code == 200
    assert snapshot.headers["content-type"] == "application/json"
    payload = snapshot.json()
    assert payload["version"] == repository.version("room")
    assert payload["room"]["snapshotRevision"] == room.snapshot_revision
    assert payload["room"]["libraryQuery"] == "shared library"
