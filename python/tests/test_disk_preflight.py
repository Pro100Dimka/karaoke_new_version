from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from backend.infrastructure.local_storage import LocalStorageSystem
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


pytestmark = pytest.mark.integration


def _ready_song(client, source: Path) -> dict[str, object]:
    song = import_song(client, source)
    started = client.post(
        f"/songs/{song['songId']}/processing",
        json={"mode": "Fast", "onlineLyrics": False},
    )
    assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
    return song


def _no_space(_self: LocalStorageSystem, _path: Path) -> int:
    return 0


def test_model_download_disk_preflight_fails_before_job_creation(
    client,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"model" * 64
    source = tmp_path / "model.bin"
    source.write_bytes(payload)
    checksum = hashlib.sha256(payload).hexdigest()
    declared = client.put(
        "/models/asr/1",
        json={
            "modelId": "asr",
            "purpose": "ASR",
            "version": "1",
            "size": len(payload),
            "checksum": checksum,
            "downloadUrl": source.resolve().as_uri(),
            "selected": False,
        },
    )
    assert declared.status_code == 200
    monkeypatch.setattr(LocalStorageSystem, "free_bytes", _no_space)

    response = client.post("/models/asr/1/download")

    assert response.status_code == 503
    assert response.json()["code"] == "InsufficientDiskSpace"
    assert client.get("/models", params={"purpose": "ASR"}).json()[0]["state"] == "Missing"


def test_package_export_disk_preflight_fails_before_background_job(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = _ready_song(client, source)
        monkeypatch.setattr(LocalStorageSystem, "free_bytes", _no_space)

        response = client.post(f"/packages/export/{song['songId']}")

        assert response.status_code == 503
        assert response.json()["code"] == "InsufficientDiskSpace"


def test_package_import_disk_preflight_does_not_publish_song(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "source", ai_providers=(FakeAiProvider(),)) as client:
        song = _ready_song(client, source)
        export = client.post(f"/packages/export/{song['songId']}")
        package_job = wait_for_job(client, export.json()["jobId"])
        package = Path(package_job["report"]["path"])

    with app_client(tmp_path / "target") as client:
        monkeypatch.setattr(LocalStorageSystem, "free_bytes", _no_space)

        response = client.post(
            "/packages/import",
            json={"path": str(package), "decision": "SafeOnly"},
        )

        assert response.status_code == 503
        assert response.json()["code"] == "InsufficientDiskSpace"
        assert client.get(f"/songs/{song['songId']}").status_code == 404
