from __future__ import annotations

import pytest
import hashlib
from pathlib import Path

from tests.helpers import wait_for_job


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
