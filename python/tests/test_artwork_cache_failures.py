from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Lock

import httpx
import pytest

from backend.infrastructure.artwork_cache import ArtworkCache


@pytest.mark.parametrize("deny_competing_replace", [False, True])
def test_concurrent_cover_requests_both_receive_the_cached_image(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, deny_competing_replace: bool
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
    denied: list[Path] = []
    publication_errors: list[dict[str, object]] = []
    replace, publication = os.replace, Lock()

    def publish(source: Path, target: Path) -> None:
        try:
            if not deny_competing_replace:
                replace(source, target)
                return
            with publication:
                if target.is_file():
                    denied.append(target)
                    raise PermissionError("A competing publication left the target busy")
                replace(source, target)
        except OSError as error:
            publication_errors.append(
                {
                    "type": type(error).__name__,
                    "errno": error.errno,
                    "winerror": getattr(error, "winerror", None),
                    "message": str(error),
                }
            )
            raise

    monkeypatch.setattr(os, "replace", publish)
    cache = ArtworkCache(tmp_path / "covers", httpx.MockTransport(download))

    with ThreadPoolExecutor(max_workers=2) as workers:
        paths = list(workers.map(cache.path_for, ["https://images.example/cover.png"] * 2))

    diagnostics = f"Returned paths: {paths!r}; os.replace errors: {publication_errors!r}"
    assert all(path is not None for path in paths), diagnostics
    assert len(denied) == int(deny_competing_replace), diagnostics
    assert paths[0] == paths[1]
    assert paths[0].read_bytes() == cover
    assert not tuple((tmp_path / "covers").glob("*.tmp"))


@pytest.mark.parametrize("target_state", ["missing", "directory", "unstatable"])
def test_failed_publication_without_a_usable_image_stays_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, target_state: str
) -> None:
    cover = b"\x89PNG\r\n\x1a\ncover"
    targets: list[Path] = []
    is_file = Path.is_file

    def fail_replace(_source: Path, target: Path) -> None:
        targets.append(target)
        if target_state == "directory":
            target.mkdir()
        elif target_state == "unstatable":
            target.write_bytes(cover)
        raise PermissionError("Publication failed")

    def inspect_target(path: Path) -> bool:
        if target_state == "unstatable" and path in targets:
            raise PermissionError("Cannot inspect the existing target")
        return is_file(path)

    monkeypatch.setattr(os, "replace", fail_replace)
    monkeypatch.setattr(Path, "is_file", inspect_target)
    transport = httpx.MockTransport(
        lambda _: httpx.Response(200, headers={"content-type": "image/png"}, content=cover)
    )

    assert (
        ArtworkCache(tmp_path / "covers", transport).path_for("https://images.example/a.png")
        is None
    )
    assert len(targets) == 1
    assert not tuple((tmp_path / "covers").glob("*.tmp"))
    if target_state == "missing":
        assert not targets[0].exists()
    elif target_state == "directory":
        assert targets[0].is_dir()
    else:
        assert targets[0].read_bytes() == cover


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
