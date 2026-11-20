from __future__ import annotations

import struct
import zlib
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.infrastructure.artwork_cache import ArtworkCache
from backend.infrastructure.clock import UtcClock
from backend.songs.recognition import RecognizedSong
from tests.conftest import app_client, write_wav
from tests.fakes import FakeRecognizer

pytestmark = pytest.mark.integration


def _png(red: int, green: int, blue: int) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack("!I", len(payload))
            + kind
            + payload
            + struct.pack("!I", zlib.crc32(kind + payload))
        )

    rows = (b"\0" + bytes((red, green, blue)) * 32) * 32
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack("!IIBBBBB", 32, 32, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def _assert_stable_cover_url(client: TestClient, song: dict) -> None:
    detail = client.get(f"/songs/{song['songId']}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["artworkUrl"] == song["artworkUrl"]
    assert detail.json()["updatedAt"] == song["updatedAt"]
    for endpoint in ("/songs", "/songs/search"):
        response = client.get(endpoint, params={"search": song["title"]})
        assert response.status_code == 200, response.text
        found = next(item for item in response.json()["items"] if item["songId"] == song["songId"])
        assert found["artworkUrl"] == song["artworkUrl"]
        assert found["updatedAt"] == song["updatedAt"]


@pytest.mark.parametrize("remote_available", [False, True])
def test_saved_and_removed_covers_change_urls_without_refetching_the_cached_catalog_image(
    tmp_path: Path, remote_available: bool
) -> None:
    source = tmp_path / "Cover singer - Cover song.wav"
    write_wav(source)
    catalog, first_image, second_image = _png(0, 90, 255), _png(240, 20, 20), _png(20, 200, 60)
    cover = tmp_path / "cover.png"
    remote = "https://images.example/catalog-cover.png"
    recognized = RecognizedSong("Cover song", "Cover singer", artwork_url=remote)
    requested: list[str] = []

    def cdn(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return (
            httpx.Response(200, headers={"content-type": "image/png"}, content=catalog)
            if remote_available
            else httpx.Response(404)
        )

    with app_client(
        tmp_path / "runtime", recognition_provider=FakeRecognizer(recognized)
    ) as client:
        client.app.state.container.artwork = ArtworkCache(
            tmp_path / "catalog-cache", httpx.MockTransport(cdn)
        )
        imported = client.post("/songs", json={"sourcePath": str(source)})
        assert imported.status_code == 201, imported.text
        before = imported.json()
        endpoint = f"/songs/{before['songId']}"
        initial = client.get(before["artworkUrl"])
        assert initial.status_code == (200 if remote_available else 404)
        if remote_available:
            assert initial.content == catalog
            assert initial.headers["cache-control"] == "max-age=86400"
        _assert_stable_cover_url(client, before)

        saved = []
        for contents in (first_image, second_image):
            # Re-selecting the same source filename must still replace the displayed image.
            cover.write_bytes(contents)
            response = client.patch(endpoint, json={"coverPath": str(cover)})
            assert response.status_code == 200, response.text
            song = response.json()
            assert song["coverState"] == "Custom"
            image = client.get(song["artworkUrl"])
            assert image.status_code == 200 and image.content == contents
            _assert_stable_cover_url(client, song)
            saved.append(song)
        assert requested == [remote]

        removed = client.delete(f"{endpoint}/cover")
        assert removed.status_code == 200, removed.text
        fallback = removed.json()
        assert fallback["coverState"] != "Custom"
        _assert_stable_cover_url(client, fallback)
        image = client.get(fallback["artworkUrl"])
        assert image.status_code == (200 if remote_available else 404)
        if remote_available:
            assert image.content == catalog
            assert image.headers["cache-control"] == "max-age=86400"
        assert requested == [remote] * (1 if remote_available else 2)

    urls = [song["artworkUrl"] for song in (before, *saved, fallback)]
    assert len(set(urls)) == 4, "Saving or removing a cover must invalidate the displayed image"
    assert all(urlsplit(url).path == f"{endpoint}/cover" for url in urls)


def test_removing_the_only_cover_clears_the_library_image(
    client: TestClient, tmp_path: Path
) -> None:
    source, cover = tmp_path / "Unrecognized song.wav", tmp_path / "cover.png"
    write_wav(source)
    cover.write_bytes(_png(240, 20, 20))
    imported = client.post("/songs", json={"sourcePath": str(source)})
    assert imported.status_code == 201, imported.text
    song = imported.json()
    endpoint = f"/songs/{song['songId']}"
    assert song["artworkUrl"] is None

    updated = client.patch(endpoint, json={"coverPath": str(cover)})
    assert updated.status_code == 200, updated.text
    served = client.get(updated.json()["artworkUrl"])
    assert served.status_code == 200 and served.content == cover.read_bytes()
    removed = client.delete(f"{endpoint}/cover")
    assert removed.status_code == 200, removed.text
    assert removed.json()["artworkUrl"] is None
    _assert_stable_cover_url(client, removed.json())
    assert client.get(f"{endpoint}/cover").status_code == 404


def test_cover_versions_preserve_subsecond_updates_and_are_scoped_to_the_song(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = datetime(2026, 11, 20, 12, 0, 0, 123456, tzinfo=UTC)
    monkeypatch.setattr(UtcClock, "now", lambda self: now)
    source, cover = tmp_path / "Cover song.wav", tmp_path / "cover.png"
    write_wav(source)
    urls = []
    with app_client(tmp_path / "runtime") as client:
        imported = client.post("/songs", json={"sourcePath": str(source)})
        assert imported.status_code == 201, imported.text
        endpoint = f"/songs/{imported.json()['songId']}"
        for contents in (_png(240, 20, 20), _png(20, 200, 60)):
            now += timedelta(microseconds=1)
            cover.write_bytes(contents)
            response = client.patch(endpoint, json={"coverPath": str(cover)})
            assert response.status_code == 200, response.text
            saved = response.json()
            assert datetime.fromisoformat(saved["updatedAt"]) == now
            _assert_stable_cover_url(client, saved)
            urls.append(saved["artworkUrl"])

        now += timedelta(seconds=1)
        other = tmp_path / "Another song.wav"
        write_wav(other, frequency=880)
        imported_other = client.post("/songs", json={"sourcePath": str(other)})
        assert imported_other.status_code == 201, imported_other.text
        response = client.patch(
            f"/songs/{imported_other.json()['songId']}", json={"title": "Renamed other song"}
        )
        assert response.status_code == 200, response.text
        _assert_stable_cover_url(client, saved)

    assert urls[0] != urls[1], "Two cover saves in the same second need distinct image URLs"
    versions = [parse_qs(urlsplit(url).query)["v"][0] for url in urls]
    assert [datetime.fromisoformat(version).microsecond for version in versions] == [123457, 123458]
