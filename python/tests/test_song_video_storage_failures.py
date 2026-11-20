from __future__ import annotations

import io
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import write_wav
from tests.helpers import import_song

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("failure", ["read-source", "create-directory"])
def test_unavailable_local_video_returns_a_storage_error_and_can_be_retried(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source, seconds=0.125)
    created = import_song(client, source, title="Original")
    endpoint = f"/songs/{created['songId']}"
    root = tmp_path / "runtime" / "songs" / created["songId"]
    if failure == "read-source":
        previous = tmp_path / "previous.mp4"
        previous.write_bytes(b"\x00\x00\x00\x18ftyporiginal-video")
        assert client.patch(endpoint, json={"videoPath": str(previous)}).status_code == 200
    selected = tmp_path / "selected.mp4"
    selected.write_bytes(b"\x00\x00\x00\x18ftypselected-video")
    before = client.get(endpoint).json()
    files = {path: path.read_bytes() for path in root.rglob("*") if path.is_file()}
    opened, mkdir = io.open, os.mkdir
    blocked: list[str] = []

    def read(path, *args, **kwargs):
        if Path(path) == selected:
            blocked.append("read-source")
            raise PermissionError("Selected video is temporarily locked")
        return opened(path, *args, **kwargs)

    def create(path, *args, **kwargs):
        if Path(path) == root / "media":
            blocked.append("create-directory")
            raise PermissionError("Song media folder is temporarily unavailable")
        return mkdir(path, *args, **kwargs)

    api = TestClient(client.app, raise_server_exceptions=False)
    try:
        with monkeypatch.context() as fault:
            if failure == "read-source":
                fault.setattr(io, "open", read)
            else:
                fault.setattr(os, "mkdir", create)
            rejected = api.patch(endpoint, json={"videoPath": str(selected), "title": "New title"})
    finally:
        api.close()

    assert blocked == [failure]
    assert rejected.status_code == 503, rejected.text
    assert rejected.json()["code"] == "StorageUnavailable"
    assert client.get(endpoint).json() == before
    assert {path: path.read_bytes() for path in root.rglob("*") if path.is_file()} == files
    assert selected.read_bytes() == b"\x00\x00\x00\x18ftypselected-video"
    retried = client.patch(endpoint, json={"videoPath": str(selected), "title": "New title"})
    assert retried.status_code == 200, retried.text
    assert retried.json()["title"] == "New title"
    assert client.get(retried.json()["videoUrl"]).content == selected.read_bytes()
