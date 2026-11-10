from __future__ import annotations

import pytest
from pathlib import Path

from backend.infrastructure.local_storage import _tree_size

pytestmark = pytest.mark.integration


def test_storage_usage_counts_file_links_but_does_not_follow_directory_links(
    tmp_path: Path,
) -> None:
    nested = tmp_path / "nested"
    nested.mkdir()
    source = nested / "file.bin"
    source.write_bytes(b"12345")
    try:
        (tmp_path / "file-link").symlink_to(source)
        (tmp_path / "directory-link").symlink_to(nested, target_is_directory=True)
        (tmp_path / "broken-link").symlink_to(tmp_path / "missing")
    except OSError as error:
        if getattr(error, "winerror", None) == 1314:
            pytest.skip("Windows symbolic-link privilege is unavailable")
        raise
    assert _tree_size(tmp_path) == 10


def test_storage_usage_counts_nested_files_without_repeated_path_stats(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    nested = tmp_path / "nested"
    nested.mkdir()
    (tmp_path / "empty").mkdir()
    files = {tmp_path / "first.bin", nested / "second.bin"}
    for path in files:
        path.write_bytes(b"12345")
    original = Path.stat
    calls: list[Path] = []

    def stat(path: Path, *, follow_symlinks: bool = True):
        if path in files:
            calls.append(path)
        return original(path, follow_symlinks=follow_symlinks)

    monkeypatch.setattr(Path, "stat", stat)
    assert _tree_size(tmp_path) == 10
    assert len(calls) <= len(files)
    assert _tree_size(tmp_path / "missing") == 0
    assert _tree_size(tmp_path / "empty") == 0


def test_cache_clear_removes_only_regenerable_cache(client) -> None:
    response = client.post("/storage/cache/clear")

    assert response.status_code == 200
    assert response.json() == {"removed": 0}
    assert client.get("/songs").status_code == 200


def test_temp_clear_is_available(client) -> None:
    response = client.post("/storage/temp/clear")

    assert response.status_code == 200
    assert response.json()["removed"] >= 0
