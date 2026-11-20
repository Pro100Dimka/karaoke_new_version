from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Event, Lock
from types import SimpleNamespace
import hashlib
import os

import anyio
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.song_routes import router as song_router
from backend.api.system_routes import router as system_router
from backend.infrastructure.artwork_cache import ArtworkCache
from backend.songs.domain import CoverState


def test_slow_cover_downloads_leave_workers_available_for_controls(tmp_path: Path) -> None:
    release = Event()
    four_downloads = Event()
    guard = Lock()
    active = 0
    cover = tmp_path / "cover.png"
    cover.write_bytes(b"cover")

    def download(_url: str) -> Path:
        nonlocal active
        with guard:
            active += 1
            if active >= 4:
                four_downloads.set()
        assert release.wait(10), "The test did not release its slow artwork source"
        return cover

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # A small shared pool reproduces the same exhaustion as forty slow CDN requests.
        limiter = anyio.to_thread.current_default_thread_limiter()
        previous = limiter.total_tokens
        limiter.total_tokens = 8
        try:
            yield
        finally:
            limiter.total_tokens = previous

    app = FastAPI(lifespan=lifespan)
    app.include_router(song_router)
    app.include_router(system_router)
    app.state.container = SimpleNamespace(
        songs=SimpleNamespace(
            get_song=SimpleNamespace(
                execute=lambda _id: SimpleNamespace(
                    cover_state=CoverState.FALLBACK,
                    cover_path=None,
                    artwork_url="https://covers.example/slow.png",
                )
            )
        ),
        artwork=SimpleNamespace(path_for=download),
    )
    with TestClient(app) as client, ThreadPoolExecutor(max_workers=17) as callers:
        pending = [callers.submit(client.get, f"/songs/song-{i}/cover") for i in range(16)]
        try:
            assert four_downloads.wait(5), "Cover requests did not reach the source"
            control = callers.submit(client.get, "/version")
            try:
                response = control.result(timeout=1)
            except TimeoutError:
                response = None
        finally:
            release.set()
        assert response is not None, "Slow covers exhausted the worker pool used by controls"
        assert response.status_code == 200
        assert all(request.result(timeout=5).status_code == 200 for request in pending)


def test_cached_cover_lookup_does_not_enumerate_the_entire_artwork_library(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    url = "https://covers.example/already-cached.png"
    cover = tmp_path / f"{hashlib.sha256(url.encode()).hexdigest()}.png"
    cover.write_bytes(b"cover")
    scandir = os.scandir

    def scanned(path):
        assert Path(path) != tmp_path, "A cache hit scanned every artwork in the library"
        return scandir(path)

    monkeypatch.setattr(os, "scandir", scanned)
    assert ArtworkCache(tmp_path).path_for(url) == cover
