from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from pathlib import Path
from types import SimpleNamespace

import pytest
import anyio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi.responses import JSONResponse

from backend.api import room_project_routes
from backend.domain_errors import DomainError


def _app(root: Path, monkeypatch) -> FastAPI:
    app = FastAPI()
    room_project_routes.add_project_routes(app, SimpleNamespace(), root)
    monkeypatch.setattr(room_project_routes, "room_member", lambda *_args: SimpleNamespace())
    monkeypatch.setattr(room_project_routes, "project_source", lambda *_args: "host")

    @app.exception_handler(DomainError)
    async def failure(_request, error: DomainError):
        return JSONResponse(
            {"code": error.code, "details": dict(error.details)}, status_code=error.status_code
        )

    @app.get("/probe")
    async def probe():
        return {"responsive": True}

    return app


@pytest.mark.parametrize("operation", ["upload-mkdir", "download-stat"])
def test_slow_project_metadata_does_not_block_room_event_loop(tmp_path, monkeypatch, operation):
    target = room_project_routes._project_path(tmp_path, "room", "song", 1, "host")
    target.parent.mkdir(parents=True)
    target.write_bytes(b"complete-project")
    app = _app(tmp_path, monkeypatch)
    entered, release = threading.Event(), threading.Event()
    name = "mkdir" if operation == "upload-mkdir" else "is_file"
    original = getattr(Path, name)

    def slow(path, *args, **kwargs):
        if path == (target.parent if name == "mkdir" else target):
            entered.set()
            assert release.wait(5)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, name, slow)
    with TestClient(app) as client, ThreadPoolExecutor(max_workers=2) as callers:
        action = client.put if name == "mkdir" else client.get
        kwargs = {"content": b"complete-project"} if name == "mkdir" else {}
        transfer = callers.submit(
            action, "/rooms/room/projects/song/1", headers={"X-Participant-Id": "host"}, **kwargs
        )
        try:
            assert entered.wait(2), "The transfer did not reach the injected disk delay"
            probe = callers.submit(client.get, "/probe")
            try:
                response = probe.result(timeout=0.2)
            except TimeoutError:
                response = None
        finally:
            release.set()
        assert transfer.result(timeout=2).status_code == (204 if name == "mkdir" else 200)
        assert response is not None, f"{operation} blocked other tasks on the room event loop"
        assert response.json() == {"responsive": True}


def test_download_rechecks_an_upload_that_starts_during_file_stat(tmp_path, monkeypatch):
    target = room_project_routes._project_path(tmp_path, "room", "song", 1, "host")
    target.parent.mkdir(parents=True)
    target.write_bytes(b"previous-project")
    app = _app(tmp_path, monkeypatch)
    checking, finish_check = threading.Event(), threading.Event()
    uploading, finish_upload = threading.Event(), threading.Event()
    is_file = Path.is_file

    def slow_stat(path):
        if path == target:
            checking.set()
            assert finish_check.wait(5)
        return is_file(path)

    async def held_upload(request, path, on_progress=None):
        content = await request.body()
        on_progress(len(content) // 2)
        uploading.set()
        assert await anyio.to_thread.run_sync(finish_upload.wait, 5)
        await anyio.to_thread.run_sync(path.write_bytes, content)

    monkeypatch.setattr(Path, "is_file", slow_stat)
    monkeypatch.setattr(room_project_routes, "store_project", held_upload)
    with TestClient(app) as client, ThreadPoolExecutor(max_workers=2) as callers:
        url = "/rooms/room/projects/song/1"
        headers = {"X-Participant-Id": "host"}
        download = callers.submit(client.get, url, headers=headers)
        upload = None
        try:
            assert checking.wait(2)
            upload = callers.submit(client.put, url, content=b"new-project", headers=headers)
            assert uploading.wait(2)
            finish_check.set()
            pending = download.result(timeout=2)
            assert pending.status_code == 404
            assert pending.json()["details"] == {"uploadBytes": 5, "uploadTotalBytes": 11}
        finally:
            finish_check.set()
            finish_upload.set()
            if upload is not None:
                assert upload.result(timeout=2).status_code == 204
            download.result(timeout=2)
        assert client.get(url, headers=headers).content == b"new-project"
