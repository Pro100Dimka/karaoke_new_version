from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from backend.domain_errors import DependencyError
from backend.infrastructure.database import SqlUnitOfWork
from backend.infrastructure.sql_songs import SqlSongRepository
from tests.conftest import write_wav
from tests.helpers import import_song


def _song_with_custom_media(client, tmp_path: Path):
    source = tmp_path / "song.wav"
    cover = tmp_path / "cover.png"
    clip = tmp_path / "video.mp4"
    write_wav(source)
    cover.write_bytes(b"\x89PNG\r\n\x1a\noriginal-cover")
    clip.write_bytes(b"\x00\x00\x00\x18ftyporiginal-video")
    song = import_song(client, source)
    endpoint = f"/songs/{song['songId']}"
    saved = client.patch(endpoint, json={"coverPath": str(cover), "videoPath": str(clip)})
    assert saved.status_code == 200, saved.text
    return endpoint, cover, clip


@pytest.mark.parametrize("field,media", [("coverPath", "cover"), ("videoPath", "clip")])
def test_failed_metadata_commit_preserves_the_committed_media(
    client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str, media: str
) -> None:
    endpoint, cover, clip = _song_with_custom_media(client, tmp_path)
    before = client.get(endpoint).json()
    original = client.get(f"{endpoint}/{media}").content
    cover.write_bytes(b"\x89PNG\r\n\x1a\nreplacement-cover")
    clip.write_bytes(b"\x00\x00\x00\x18ftypreplacement-video")

    def fail_commit(_session: Session) -> None:
        raise SQLAlchemyError("Database commit interrupted")

    with monkeypatch.context() as fault:
        fault.setattr(Session, "commit", fail_commit)
        response = client.patch(
            endpoint,
            json={field: str(cover if media == "cover" else clip), "title": "Unsaved title"},
        )

    assert response.status_code == 503, response.text
    assert response.json()["code"] == "DatabaseWriteFailed"
    assert client.get(endpoint).json() == before
    assert client.get(f"{endpoint}/{media}").content == original


def test_invalid_cover_keeps_the_committed_clip_and_metadata(client, tmp_path: Path) -> None:
    endpoint, _cover, clip = _song_with_custom_media(client, tmp_path)
    before = client.get(endpoint).json()
    original = client.get(f"{endpoint}/clip").content
    clip.write_bytes(b"\x00\x00\x00\x18ftypreplacement-video")

    response = client.patch(
        endpoint,
        json={
            "videoPath": str(clip),
            "coverPath": str(tmp_path / "missing-cover.png"),
            "title": "Unsaved title",
        },
    )

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "CoverNotFound"
    assert client.get(endpoint).json() == before
    assert client.get(f"{endpoint}/clip").content == original


def test_metadata_write_failure_restores_both_media_files(
    client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    endpoint, cover, clip = _song_with_custom_media(client, tmp_path)
    before = client.get(endpoint).json()
    originals = {media: client.get(f"{endpoint}/{media}").content for media in ("cover", "clip")}
    cover.write_bytes(b"replacement-cover")
    clip.write_bytes(b"\x00\x00\x00\x18ftypreplacement-video")

    def fail_update(*_args: object) -> None:
        raise SQLAlchemyError("Metadata write interrupted")

    with monkeypatch.context() as fault:
        fault.setattr(SqlSongRepository, "update_metadata", fail_update)
        response = client.patch(
            endpoint, json={"coverPath": str(cover), "videoPath": str(clip), "title": "Unsaved"}
        )

    assert response.status_code == 503, response.text
    assert client.get(endpoint).json() == before
    assert {media: client.get(f"{endpoint}/{media}").content for media in originals} == originals
    assert not tuple((tmp_path / "runtime" / "songs").rglob("*.backup"))


def test_failed_first_media_save_removes_the_uncommitted_files(
    client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    song = import_song(client, source)
    endpoint = f"/songs/{song['songId']}"
    before = client.get(endpoint).json()
    cover, clip = tmp_path / "cover.png", tmp_path / "video.mp4"
    cover.write_bytes(b"custom-cover")
    clip.write_bytes(b"\x00\x00\x00\x18ftypcustom-video")

    def fail_commit(_session: Session) -> None:
        raise SQLAlchemyError("Database commit interrupted")

    with monkeypatch.context() as fault:
        fault.setattr(Session, "commit", fail_commit)
        response = client.patch(endpoint, json={"coverPath": str(cover), "videoPath": str(clip)})

    assert response.status_code == 503, response.text
    assert client.get(endpoint).json() == before
    root = tmp_path / "runtime" / "songs" / song["songId"]
    assert not tuple((root / "cover").glob("*"))
    assert not tuple((root / "media").glob("*"))


def test_cover_copy_failure_rolls_back_the_already_copied_video(
    client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    endpoint, cover, clip = _song_with_custom_media(client, tmp_path)
    before = client.get(endpoint).json()
    original = client.get(f"{endpoint}/clip").content
    clip.write_bytes(b"\x00\x00\x00\x18ftypreplacement-video")
    storage = client.app.state.container.songs.update_song._storage

    def fail_copy(*_args: object) -> None:
        raise DependencyError("StorageUnavailable", "Cover copy interrupted")

    monkeypatch.setattr(storage, "copy_cover", fail_copy)
    response = client.patch(endpoint, json={"coverPath": str(cover), "videoPath": str(clip)})

    assert response.status_code == 503, response.text
    assert client.get(endpoint).json() == before
    assert client.get(f"{endpoint}/clip").content == original


def test_reselecting_managed_media_does_not_remove_it_when_commit_fails(
    client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    endpoint, cover, _clip = _song_with_custom_media(client, tmp_path)
    root = tmp_path / "runtime" / "songs" / endpoint.rsplit("/", 1)[1]
    before = client.get(endpoint).json()
    originals = {media: client.get(f"{endpoint}/{media}").content for media in ("cover", "clip")}

    def fail_commit(_session: Session) -> None:
        raise SQLAlchemyError("Database commit interrupted")

    with monkeypatch.context() as fault:
        fault.setattr(Session, "commit", fail_commit)
        response = client.patch(
            endpoint,
            json={
                "coverPath": str(root / "cover" / cover.name),
                "videoPath": str(root / "media" / "clip.mp4"),
            },
        )

    assert response.status_code == 503, response.text
    assert client.get(endpoint).json() == before
    assert {media: client.get(f"{endpoint}/{media}").content for media in originals} == originals


def test_missing_managed_cover_is_still_rejected(client, tmp_path: Path) -> None:
    endpoint, cover, _clip = _song_with_custom_media(client, tmp_path)
    before = client.get(endpoint).json()
    managed = tmp_path / "runtime" / "songs" / endpoint.rsplit("/", 1)[1] / "cover" / cover.name
    managed.unlink()

    response = client.patch(endpoint, json={"coverPath": str(managed)})

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "CoverNotFound"
    assert client.get(endpoint).json() == before


def test_committed_media_survives_a_later_database_cleanup_failure(
    client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    endpoint, cover, _clip = _song_with_custom_media(client, tmp_path)
    cover.write_bytes(b"committed-replacement-cover")
    close = SqlUnitOfWork.__exit__

    def fail_cleanup(transaction, *args):
        close(transaction, *args)
        raise DependencyError("DatabaseCleanupFailed", "Cleanup interrupted after commit")

    with monkeypatch.context() as fault:
        fault.setattr(SqlUnitOfWork, "__exit__", fail_cleanup)
        response = client.patch(endpoint, json={"coverPath": str(cover), "title": "Committed"})

    assert response.status_code == 503, response.text
    assert client.get(endpoint).json()["title"] == "Committed"
    assert client.get(f"{endpoint}/cover").content == cover.read_bytes()
