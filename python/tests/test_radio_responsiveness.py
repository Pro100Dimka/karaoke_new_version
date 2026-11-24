import asyncio
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import asynccontextmanager
from threading import Event, Lock
from types import SimpleNamespace

import anyio
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.radio_routes import router as radio_router
from backend.api.system_routes import router as system_router
from backend.api.errors import domain_error_response
from backend.bootstrap.lifecycle import BackendLifecycle
from backend.domain_errors import DomainError
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.infrastructure.youtube_radio import YoutubeRadio
from backend.serialization import dumps, loads_object


def test_slow_youtube_resolvers_leave_workers_available_for_controls(monkeypatch):
    release, resolving = Event(), Event()
    guard = Lock()
    active = 0
    maximum = 0

    def resolve(_self, playlist_id, index, *, cancel=None):
        nonlocal active, maximum
        with guard:
            active += 1
            maximum = max(maximum, active)
            if active >= 2:
                resolving.set()
        try:
            assert release.wait(10), "The test did not release its slow YouTube requests"
            return {"playlistId": playlist_id, "index": index, "url": "https://audio.example/test"}
        finally:
            with guard:
                active -= 1

    @asynccontextmanager
    async def lifespan(_app):
        limiter = anyio.to_thread.current_default_thread_limiter()
        previous = limiter.total_tokens
        limiter.total_tokens = 4
        try:
            yield
        finally:
            limiter.total_tokens = previous

    app = FastAPI(lifespan=lifespan)
    app.include_router(radio_router)
    app.include_router(system_router)
    app.state.container = SimpleNamespace(lifecycle=BackendLifecycle())
    monkeypatch.setattr(YoutubeRadio, "resolve", resolve)
    with TestClient(app) as client, ThreadPoolExecutor(max_workers=17) as callers:
        pending = [
            callers.submit(client.get, f"/radio/youtube?playlist_id=PL1234567890&index={i + 1}")
            for i in range(16)
        ]
        try:
            assert resolving.wait(5), "The test did not reach the resolver"
            control = callers.submit(client.get, "/health/live")
            try:
                response = control.result(timeout=1)
            except TimeoutError:
                response = None
        finally:
            release.set()
        assert response is not None, "YouTube resolution exhausted workers used by controls"
        assert response.status_code == 200 and response.json()["ok"]
        assert all(request.result(timeout=5).status_code == 200 for request in pending)
        assert maximum <= 2


def _request(app, index):
    incoming = asyncio.Queue()
    incoming.put_nowait({"type": "http.request", "body": b"", "more_body": False})
    messages = []

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/radio/youtube",
        "query_string": f"playlist_id=PL1234567890&index={index}".encode(),
        "headers": [],
    }
    return asyncio.create_task(app(scope, incoming.get, send)), incoming, messages


@pytest.mark.asyncio
@pytest.mark.parametrize("disconnect_queued", [False, True])
@pytest.mark.parametrize("stage", ["playlist", "audio"])
async def test_disconnected_youtube_requests_release_the_latest_track(
    monkeypatch, disconnect_queued, stage
):
    entered, cleanup = Event(), Event()
    guard = Lock()
    invoked, cancelled = [], []

    def run(_self, command, **kwargs):
        playlist = "--flat-playlist" in command
        if playlist:
            index = int(command[command.index("--playlist-items") + 1])
            payload = {"entries": [{"id": f"video{index:06d}"}]}
        else:
            index = int(command[-1].rsplit("video", 1)[1])
            payload = {"title": "Current", "url": "https://audio.example/current"}
        if playlist == (stage == "playlist"):
            with guard:
                invoked.append(index)
                if len(invoked) >= 2:
                    entered.set()
            if index < 3:
                cancel = kwargs.get("cancel")
                assert (cancel or cleanup).wait(3), "Disconnected resolution was not stopped"
                if cancel is not None and cancel.is_set():
                    with guard:
                        cancelled.append(index)
                    raise DomainError("ProcessCancelled", "External process was cancelled", 499)
        return ProcessResult(0, dumps(payload).encode(), b"")

    monkeypatch.setattr(ProcessRunner, "run", run)
    app = FastAPI()
    app.include_router(radio_router)
    requests = [_request(app, index) for index in (1, 2)]
    try:
        assert await anyio.to_thread.run_sync(entered.wait, 2)
        latest = _request(app, 3)
        requests.append(latest)
        for _task, incoming, _messages in (requests[-1:] if disconnect_queued else requests[:2]):
            incoming.put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(asyncio.shield(latest[0]), 1)
        start = next(message for message in latest[2] if message["type"] == "http.response.start")
        if disconnect_queued:
            assert start["status"] == 499
            assert invoked == [1, 2]
        else:
            assert start["status"] == 200
            body = next(message["body"] for message in latest[2] if message["type"] == "http.response.body")
            assert loads_object(body.decode())["index"] == 3
            await asyncio.gather(*(item[0] for item in requests[:2]))
            assert sorted(cancelled) == [1, 2]
    finally:
        cleanup.set()
        for _task, incoming, _messages in requests:
            incoming.put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(asyncio.gather(*(item[0] for item in requests)), 4)


def test_youtube_failure_keeps_its_api_error_after_disconnect_monitoring(monkeypatch):
    def unavailable(_self, *_args, **_kwargs):
        raise DomainError("YoutubePlaylistUnavailable", "Playlist is unavailable", 422)

    monkeypatch.setattr(YoutubeRadio, "resolve", unavailable)
    app = FastAPI()
    app.include_router(radio_router)
    app.add_exception_handler(DomainError, domain_error_response)
    with TestClient(app) as client:
        response = client.get("/radio/youtube?playlist_id=PL1234567890")
    assert response.status_code == 422
    assert response.json()["code"] == "YoutubePlaylistUnavailable"


@pytest.mark.asyncio
async def test_parent_cancellation_stops_active_youtube_resolver(monkeypatch):
    entered, cancelled, cleanup = Event(), Event(), Event()

    def run(_self, _command, **kwargs):
        cancel = kwargs["cancel"]
        entered.set()
        while not cancel.wait(0.01):
            if cleanup.is_set():
                return ProcessResult(0, b"{}", b"")
        cancelled.set()
        raise DomainError("ProcessCancelled", "External process was cancelled", 499)

    monkeypatch.setattr(ProcessRunner, "run", run)
    app = FastAPI()
    app.include_router(radio_router)
    parent = anyio.CancelScope()

    async def cancellable_app(scope, receive, send):
        with parent:
            await app(scope, receive, send)

    request, incoming, _messages = _request(cancellable_app, 1)
    try:
        assert await anyio.to_thread.run_sync(entered.wait, 2)
        parent.cancel()
        assert await anyio.to_thread.run_sync(cancelled.wait, 1), (
            "Parent cancellation did not stop the active YouTube process"
        )
        await asyncio.wait_for(asyncio.shield(request), 1)
    finally:
        cleanup.set()
        incoming.put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(asyncio.gather(request, return_exceptions=True), 4)
