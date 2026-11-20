from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
import os
from time import perf_counter
from unittest.mock import Mock

import pytest

from backend.bootstrap.config import BackendConfig
from backend.bootstrap.song_wiring import build_song_cases
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.local_projects import LocalProjectStorage
from backend.projects.domain import ArtifactCategory, ProjectArtifact, ProjectManifest
from backend.projects.manifest_codec import encode_manifest
from backend.songs.domain import Song, SongStatus, SourceState


def _song(root: Path, index: int = 0) -> Song:
    now = datetime.now(UTC)
    song = Song(
        f"song-{index}",
        "Title",
        "Artist",
        "source",
        SourceState.PACKAGE_ONLY,
        None,
        SongStatus.READY,
        1,
        1,
        now,
        now,
        video_url="local:clip",
    )
    folder = root / "songs" / song.song_id
    clip = folder / "media" / "clip.mp4"
    clip.parent.mkdir(parents=True)
    clip.write_bytes(f"clip {index:04}".encode() * 1024)
    manifest = ProjectManifest(
        1,
        song.song_id,
        1,
        (ProjectArtifact("lyricsSync", Path("lyrics.json"), ArtifactCategory.PORTABLE, "a" * 64),),
        {},
    )
    path = folder / "revisions" / "1" / "manifest.json"
    path.parent.mkdir(parents=True)
    path.write_text(encode_manifest(manifest), encoding="utf-8")
    return song


def _query(root: Path, hasher: Mock):
    config = BackendConfig.load(root)
    runtime = Mock(config=config, hasher=hasher)
    project = Mock(projects=LocalProjectStorage(config.roots))
    return build_song_cases(runtime, project, Mock(lyrics_providers=()), Mock()).get_song


@pytest.mark.parametrize("reopen", [False, True])
def test_refresh_and_reopen_do_not_rehash_an_unchanged_large_clip_library(tmp_path, reopen):
    songs = [_song(tmp_path, index) for index in range(300)]
    hasher = Mock(wraps=sha256_file)
    query = _query(tmp_path, hasher)
    original = [query.project_hash(song) for song in songs]
    assert all(value is not None for value in original)
    assert hasher.call_count == len(songs)
    hasher.reset_mock()
    if reopen:
        query = _query(tmp_path, hasher)

    assert [query.project_hash(song) for song in songs] == original
    assert hasher.call_count == 0, "Refreshing cards reread every unchanged clip in full"


def test_nonready_song_does_not_read_or_cache_its_clip(tmp_path):
    song = replace(_song(tmp_path), status=SongStatus.PROCESSING)
    hasher = Mock(wraps=sha256_file)
    assert _query(tmp_path, hasher).project_hash(song) is None
    hasher.assert_not_called()


def test_clip_cache_uses_the_configured_backend_cache_root(tmp_path):
    song = _song(tmp_path)
    assert _query(tmp_path, Mock(wraps=sha256_file)).project_hash(song) is not None
    assert list((BackendConfig.load(tmp_path).roots.cache / "clip-hashes").glob("*.json"))


def test_cold_library_browsing_does_not_force_durable_cache_writes(tmp_path, monkeypatch):
    songs = [_song(tmp_path, index) for index in range(300)]
    sync = Mock(wraps=os.fsync)
    monkeypatch.setattr(os, "fsync", sync)
    query = _query(tmp_path, Mock(wraps=sha256_file))
    started = perf_counter()
    assert all(query.project_hash(song) for song in songs)
    print(
        {
            "clips": len(songs),
            "fsync_calls": sync.call_count,
            "cold_seconds": round(perf_counter() - started, 6),
        }
    )
    assert sync.call_count == 0, "A disposable cache adds a durability barrier for every clip"
