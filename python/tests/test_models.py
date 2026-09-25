from __future__ import annotations

import pytest
import hashlib
from pathlib import Path

from tests.conftest import app_client
from tests.helpers import wait_for_job
from backend.domain_errors import DomainError
from backend.infrastructure.http_downloader import HttpDownloader


pytestmark = pytest.mark.integration


def declare(
    client, model_id: str, version: str, payload: bytes, source: Path, checksum: str | None = None
):
    source.write_bytes(payload)
    digest = checksum or hashlib.sha256(payload).hexdigest()
    response = client.put(
        f"/models/{model_id}/{version}",
        json={
            "modelId": model_id,
            "purpose": "ASR",
            "version": version,
            "size": len(payload),
            "checksum": digest,
            "downloadUrl": source.resolve().as_uri(),
            "selected": False,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_model_download_verifies_checksum_before_ready(client, tmp_path: Path) -> None:
    payload = b"model-data" * 32
    model = declare(client, "asr", "1", payload, tmp_path / "model.bin")
    assert model["state"] == "Missing"

    started = client.post("/models/asr/1/download")
    assert started.status_code == 202, started.text
    job = wait_for_job(client, started.json()["jobId"])

    assert job["state"] == "Succeeded", job
    listed = client.get("/models", params={"purpose": "ASR"}).json()
    assert listed[0]["state"] == "Ready"
    assert Path(listed[0]["localPath"]).is_file()

    selected = client.post("/models/asr/1/select")
    assert selected.status_code == 200
    assert selected.json()["selected"] is True


def test_invalid_checksum_never_marks_partial_model_ready(client, tmp_path: Path) -> None:
    payload = b"bad-model" * 32
    declare(client, "asr", "bad", payload, tmp_path / "bad.bin", checksum="0" * 64)

    started = client.post("/models/asr/bad/download")
    job = wait_for_job(client, started.json()["jobId"])

    assert job["state"] == "Failed"
    models = client.get("/models", params={"purpose": "ASR"}).json()
    failed = next(item for item in models if item["version"] == "bad")
    assert failed["state"] == "Failed"
    assert failed["localPath"] is None


def test_failed_new_model_does_not_delete_working_version(client, tmp_path: Path) -> None:
    good = b"good" * 64
    declare(client, "asr", "1", good, tmp_path / "v1.bin")
    first = client.post("/models/asr/1/download")
    assert wait_for_job(client, first.json()["jobId"])["state"] == "Succeeded"
    assert client.post("/models/asr/1/select").status_code == 200

    bad = b"new" * 64
    declare(client, "asr", "2", bad, tmp_path / "v2.bin", checksum="f" * 64)
    second = client.post("/models/asr/2/download")
    assert wait_for_job(client, second.json()["jobId"])["state"] == "Failed"

    models = client.get("/models", params={"purpose": "ASR"}).json()
    version_one = next(item for item in models if item["version"] == "1")
    version_two = next(item for item in models if item["version"] == "2")
    assert version_one["state"] == "Ready"
    assert version_one["selected"] is True
    assert Path(version_one["localPath"]).is_file()
    assert version_two["state"] == "Failed"


def test_existing_shared_model_is_reused_by_a_fresh_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b"already-downloaded-model" * 16
    digest = hashlib.sha256(payload).hexdigest()
    shared_models = tmp_path / "shared-models"
    existing = shared_models / "asr" / "shared" / "model.bin"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(payload)
    monkeypatch.setenv("AD_VOICE_MODELS", str(shared_models))

    with app_client(tmp_path / "fresh-profile") as fresh_client:
        declared = fresh_client.put(
            "/models/asr/shared",
            json={
                "modelId": "asr",
                "purpose": "ASR",
                "version": "shared",
                "size": len(payload),
                "checksum": digest,
                "downloadUrl": None,
                "selected": False,
            },
        )

    assert declared.status_code == 200, declared.text
    assert declared.json()["state"] == "Ready"
    assert Path(declared.json()["localPath"]) == existing.resolve()


@pytest.mark.parametrize("change", ["checksum", "size", "missing"])
def test_redeclaring_a_model_does_not_preserve_invalid_ready_state(client, tmp_path, change):
    payload = b"weights"
    source = tmp_path / "source.bin"
    declare(client, "asr", "audit", payload, source)
    started = client.post("/models/asr/audit/download")
    assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
    current = next(item for item in client.get("/models").json() if item["version"] == "audit")
    if change == "missing":
        Path(current["localPath"]).unlink()
    updated_payload = payload + b"more" if change == "size" else payload
    checksum = "f" * 64 if change == "checksum" else None
    updated = declare(client, "asr", "audit", updated_payload, source, checksum)
    assert updated["state"] == "Missing"
    assert updated["localPath"] is None


@pytest.mark.parametrize(
    "failure", [DomainError("DownloadCancelled", "Cancelled", 499), OSError("Disk full")]
)
def test_download_failure_always_removes_partial_file_and_settles_model(
    client, tmp_path, monkeypatch, failure
):
    targets = []

    def failed_download(self, url, target, **kwargs):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"partial")
        targets.append(target)
        raise failure

    monkeypatch.setattr(HttpDownloader, "download", failed_download)
    declare(client, "asr", "audit", b"weights", tmp_path / "source.bin")
    started = client.post("/models/asr/audit/download")
    assert wait_for_job(client, started.json()["jobId"])["state"] == "Failed"
    model = next(item for item in client.get("/models").json() if item["version"] == "audit")
    assert model["state"] == "Failed"
    assert targets and not targets[0].exists()
