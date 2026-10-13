from __future__ import annotations

import pytest
import hashlib
import logging
import threading
from pathlib import Path

from tests.conftest import app_client
from tests.helpers import wait_for_job
from backend.domain_errors import DomainError
from backend.infrastructure.http_downloader import HttpDownloader
from backend.infrastructure.file_hasher import Sha256FileHasher
import backend.infrastructure.http_downloader as downloader_module


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


def test_invalid_checksum_never_marks_partial_model_ready(
    client, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    payload = b"bad-model" * 32
    declare(client, "asr", "bad", payload, tmp_path / "bad.bin", checksum="0" * 64)

    with caplog.at_level(logging.WARNING, logger="backend.processing.job_manager"):
        started = client.post("/models/asr/bad/download")
        job = wait_for_job(client, started.json()["jobId"])

    assert job["state"] == "Failed"
    # Why it failed reaches the program log, not only the job's record.
    failure = next(record for record in caplog.records if record.getMessage() == "Background job failed")
    assert getattr(failure, "jobId") == started.json()["jobId"]
    assert getattr(failure, "errorCode") == job["error"]["code"]
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


def test_failed_redownload_preserves_verified_same_version(client, tmp_path, monkeypatch):
    declare(client, "asr", "retry", b"verified-weights", tmp_path / "source.bin")
    first = client.post("/models/asr/retry/download")
    assert wait_for_job(client, first.json()["jobId"])["state"] == "Succeeded"
    assert client.post("/models/asr/retry/select").status_code == 200

    def failed_download(*args, **kwargs):
        raise OSError("network unavailable")

    monkeypatch.setattr(HttpDownloader, "download", failed_download)
    second = client.post("/models/asr/retry/download")
    assert wait_for_job(client, second.json()["jobId"])["state"] == "Failed"
    model = next(item for item in client.get("/models").json() if item["version"] == "retry")
    assert model["state"] == "Ready"
    assert model["selected"] is True
    assert Path(model["localPath"]).read_bytes() == b"verified-weights"


@pytest.mark.parametrize("failure_last", [True, False])
def test_concurrent_failed_download_cannot_hide_verified_completion(
    client, tmp_path, monkeypatch, failure_last
):
    payload = b"verified-weights"
    declare(client, "asr", "concurrent", payload, tmp_path / "source.bin")
    entered, release = threading.Event(), threading.Event()
    calls = 0

    def download(self, url, target, **kwargs):
        nonlocal calls
        calls += 1
        first = calls == 1
        if first:
            entered.set()
            assert release.wait(5)
        if first == failure_last:
            raise OSError("network unavailable")
        target.write_bytes(payload)
        return len(payload)

    monkeypatch.setattr(HttpDownloader, "download", download)
    first = client.post("/models/asr/concurrent/download").json()["jobId"]
    assert entered.wait(5)
    try:
        second = client.post("/models/asr/concurrent/download").json()["jobId"]
        assert wait_for_job(client, second)["state"] == ("Succeeded" if failure_last else "Failed")
    finally:
        release.set()
    assert wait_for_job(client, first)["state"] == ("Failed" if failure_last else "Succeeded")
    model = next(item for item in client.get("/models").json() if item["version"] == "concurrent")
    assert model["state"] == "Ready"
    assert Path(model["localPath"]).read_bytes() == payload


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


@pytest.mark.parametrize("phase", ["download", "verification"])
def test_cancelled_model_download_does_not_fail_or_publish_uncommitted_weights(
    client, tmp_path, monkeypatch, phase
):
    payload = b"verified-model-weights"
    declare(client, "asr", "cancelled", payload, tmp_path / "source.bin")
    entered, release = threading.Event(), threading.Event()

    class Response:
        reads = 0

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self, size):
            self.reads += 1
            if self.reads == 1:
                return payload[:8]
            if self.reads == 2:
                if phase == "download":
                    entered.set()
                    assert release.wait(5)
                return payload[8:]
            return b""

    original_hash = Sha256FileHasher.hash_file

    def hash_file(self, path):
        result = original_hash(self, path)
        if phase == "verification":
            entered.set()
            assert release.wait(5)
        return result

    with monkeypatch.context() as patch:
        patch.setattr(downloader_module.urllib.request, "urlopen", lambda *a, **k: Response())
        patch.setattr(Sha256FileHasher, "hash_file", hash_file)
        started = client.post("/models/asr/cancelled/download")
        job_id = started.json()["jobId"]
        try:
            assert entered.wait(5)
            assert client.post(f"/jobs/{job_id}/cancel").status_code == 200
        finally:
            release.set()
        job = wait_for_job(client, job_id)
    assert job["state"] == "Cancelled", job
    model = next(item for item in client.get("/models").json() if item["version"] == "cancelled")
    assert model["state"] == "Failed"
    assert model["localPath"] is None
    assert not list((tmp_path / "runtime/models/asr/cancelled").glob("*"))
    retry = client.post("/models/asr/cancelled/download")
    assert wait_for_job(client, retry.json()["jobId"])["state"] == "Succeeded"
