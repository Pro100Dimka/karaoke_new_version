from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from backend.infrastructure import profile_migration
from backend.infrastructure.hashing import sha256_file
from tests.conftest import app_client, write_wav
from tests.helpers import import_song


def test_profile_migration_preserves_media_models_and_database(tmp_path: Path) -> None:
    profile = tmp_path / "source-profile"
    target = tmp_path / "installation" / "data" / "profile"
    external = tmp_path / "original.wav"
    write_wav(external)
    with app_client(profile / "backend-data") as client:
        song = import_song(client, external, title="Твій текст", artist="Исполнитель")
    model = profile / "backend-data" / "models" / "weights.bin"
    model.parent.mkdir(parents=True, exist_ok=True)
    model.write_bytes(b"preserve-model-weights")
    checksum = sha256_file(external)

    profile_migration.migrate(profile, target)

    assert external.is_file() and sha256_file(external) == checksum
    assert (
        target / "backend-data" / "models" / "weights.bin"
    ).read_bytes() == b"preserve-model-weights"
    with sqlite3.connect(target / "backend-data" / "app.db") as database:
        row = database.execute("SELECT song_id,title,artist,source_path FROM songs").fetchone()
    assert row[:3] == (song["songId"], "Твій текст", "Исполнитель")
    copied = Path(row[3])
    assert copied.is_relative_to(target) and sha256_file(copied) == checksum
    assert profile.resolve() == target.resolve()
    profile_migration.migrate(profile, target)
    assert sha256_file(copied) == checksum


def test_failed_copy_keeps_original_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile = tmp_path / "source-profile"
    target = tmp_path / "installation" / "data" / "profile"
    source = profile / "backend-data" / "models" / "weights.bin"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"irreplaceable")

    def fail_copy(*args: object, **kwargs: object) -> str:
        raise OSError("simulated copy failure")

    monkeypatch.setattr(profile_migration, "_copy", fail_copy)
    with pytest.raises(OSError, match="simulated copy failure"):
        profile_migration.migrate(profile, target)
    assert source.read_bytes() == b"irreplaceable"
    assert not target.exists()


def test_copy_refuses_conflicting_destination(tmp_path: Path) -> None:
    source, target = tmp_path / "source.bin", tmp_path / "target.bin"
    source.write_bytes(b"source")
    target.write_bytes(b"different-existing-data")
    with pytest.raises(ValueError):
        profile_migration._copy(source, target, {}, tmp_path, sha256_file(target))
    assert source.read_bytes() == b"source"
    assert target.read_bytes() == b"different-existing-data"
