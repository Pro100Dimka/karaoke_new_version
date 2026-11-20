from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import write_wav
from tests.helpers import wait_for_job

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("queued", [False, True])
def test_import_directory_failure_reports_storage_and_retries_without_pending_recovery(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, queued: bool
) -> None:
    source = tmp_path / "Selected.wav"
    write_wav(source, seconds=0.125)
    original = source.read_bytes()
    container = client.app.state.container
    endpoint = "/songs/imports" if queued else "/songs"
    body = {"sourcePath": str(source), "title": "Selected song"}
    headers = {"Idempotency-Key": "import-source-directory"}
    mkdir = os.mkdir
    blocked: list[Path] = []

    def create(path, *args, **kwargs):
        directory = Path(path)
        if directory.name == "source" and directory.parent.parent == container.roots.songs:
            blocked.append(directory)
            raise PermissionError("Cannot create the song source folder")
        return mkdir(path, *args, **kwargs)

    api = TestClient(client.app, raise_server_exceptions=False)
    try:
        with monkeypatch.context() as fault:
            fault.setattr(os, "mkdir", create)
            response = api.post(endpoint, json=body, headers=headers)
            job = wait_for_job(client, response.json()["jobId"]) if queued else None
    finally:
        api.close()

    observed = {
        "status": response.status_code,
        "code": job["error"]["code"] if job else response.json()["code"],
        "state": job["state"] if job else None,
        "pending_recovery": len(container.songs.import_song._journal.entries()),
        "song_count": len(client.get("/songs").json()["items"]),
        "managed_files": len(tuple(container.roots.songs.rglob("*"))),
    }
    assert len(blocked) == 1
    assert observed == {
        "status": 202 if queued else 503,
        "code": "StorageUnavailable",
        "state": "Failed" if queued else None,
        "pending_recovery": 0,
        "song_count": 0,
        "managed_files": 0,
    }
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
