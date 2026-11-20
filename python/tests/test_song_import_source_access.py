from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import write_wav
from tests.helpers import wait_for_job

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("queued", [False, True])
def test_locked_selected_audio_reports_storage_failure_and_imports_after_retry(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, queued: bool
) -> None:
    source = tmp_path / "Selected.wav"
    write_wav(source, seconds=0.125)
    original = source.read_bytes()
    endpoint = "/songs/imports" if queued else "/songs"
    body = {"sourcePath": str(source), "title": "Selected song"}
    headers = {"Idempotency-Key": "selected-source-import"}
    opened = io.open
    blocked: list[Path] = []

    def read(path, *args, **kwargs):
        if Path(path) == source:
            blocked.append(source)
            raise PermissionError("Selected audio is temporarily locked")
        return opened(path, *args, **kwargs)

    api = TestClient(client.app, raise_server_exceptions=False)
    try:
        with monkeypatch.context() as fault:
            fault.setattr(io, "open", read)
            rejected = api.post(endpoint, json=body, headers=headers)
            failure = wait_for_job(client, rejected.json()["jobId"]) if queued else None
    finally:
        api.close()

    assert blocked == [source]
    if queued:
        assert rejected.status_code == 202, rejected.text
        assert failure["state"] == "Failed", failure
        assert failure["error"]["code"] == "StorageUnavailable"
        assert failure["report"] is None
    else:
        assert rejected.status_code == 503, rejected.text
        assert rejected.json()["code"] == "StorageUnavailable"
    container = client.app.state.container
    assert client.get("/songs").json()["items"] == []
    assert not tuple(container.roots.songs.iterdir())
    assert not container.songs.import_song._journal.entries()
    assert source.read_bytes() == original

    retried = client.post(endpoint, json=body, headers=headers)
    assert retried.status_code == (202 if queued else 201), retried.text
    if queued:
        completed = wait_for_job(client, retried.json()["jobId"])
        assert completed["state"] == "Succeeded", completed
        song = client.get(f"/songs/{completed['report']['songId']}").json()
    else:
        song = retried.json()
    assert song["title"] == "Selected song"
    assert Path(song["sourcePath"]).read_bytes() == original
    assert source.read_bytes() == original
    assert len(client.get("/songs").json()["items"]) == 1
    assert not container.songs.import_song._journal.entries()
