from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import httpx
import pytest

from backend.infrastructure.artwork_cache import ArtworkCache


def test_concurrent_cover_requests_both_receive_the_cached_image(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    requested, written = Barrier(2), Barrier(2)
    cover = b"\x89PNG\r\n\x1a\ncover"

    def download(_request: httpx.Request) -> httpx.Response:
        requested.wait(timeout=5)
        return httpx.Response(200, headers={"content-type": "image/png"}, content=cover)

    write_bytes = Path.write_bytes

    def overlap_writes(path: Path, data: bytes) -> int:
        size = write_bytes(path, data)
        if path.suffix == ".tmp":
            written.wait(timeout=5)
        return size

    monkeypatch.setattr(Path, "write_bytes", overlap_writes)
    cache = ArtworkCache(tmp_path / "covers", httpx.MockTransport(download))

    with ThreadPoolExecutor(max_workers=2) as workers:
        paths = list(workers.map(cache.path_for, ["https://images.example/cover.png"] * 2))

    assert all(path is not None for path in paths)
    assert paths[0] == paths[1]
    assert paths[0].read_bytes() == cover
    assert not tuple((tmp_path / "covers").glob("*.tmp"))


def test_cover_download_stops_before_buffering_an_unbounded_response(tmp_path: Path) -> None:
    class OversizedImage(httpx.SyncByteStream):
        consumed = 0

        def __iter__(self):
            for _ in range(20):
                chunk = b"x" * (1024 * 1024)
                self.consumed += len(chunk)
                yield chunk

    stream = OversizedImage()
    transport = httpx.MockTransport(
        lambda _: httpx.Response(200, headers={"content-type": "image/png"}, stream=stream)
    )
    cache = ArtworkCache(tmp_path / "covers", transport)

    assert cache.path_for("https://images.example/oversized.png") is None
    assert stream.consumed <= 9 * 1024 * 1024
    assert not tuple((tmp_path / "covers").glob("*"))


def test_unavailable_cache_does_not_raise_from_a_cover_request(tmp_path: Path) -> None:
    blocked = tmp_path / "covers"
    blocked.write_text("not a directory")
    transport = httpx.MockTransport(
        lambda _: httpx.Response(
            200, headers={"content-type": "image/png"}, content=b"\x89PNG\r\n\x1a\ncover"
        )
    )

    assert ArtworkCache(blocked, transport).path_for("https://images.example/cover.png") is None
