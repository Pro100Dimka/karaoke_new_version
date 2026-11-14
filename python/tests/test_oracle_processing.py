from __future__ import annotations

import threading
import zipfile
import importlib.util
import sys
from pathlib import Path

import httpx
import pytest

from backend.domain_errors import DomainError
from backend.infrastructure.processing_transport import ProcessingTransport, read_bundle, write_bundle


@pytest.fixture
def relay(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("AD_VOICE_PROCESSING_DATA", str(tmp_path / "relay"))
    monkeypatch.setenv("AD_VOICE_PROCESSING_TOKEN", "client-key-" * 4)
    monkeypatch.setenv("AD_VOICE_PROCESSING_WORKER_TOKEN", "worker-key-" * 4)
    spec = importlib.util.spec_from_file_location(
        "processing_relay_test", Path(__file__).parents[2] / "scripts/processing-server.py"
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    with TestClient(module.app) as client:
        yield module, client


def test_relay_separates_credentials_and_returns_result_only_after_completion(relay):
    module, client = relay
    client_headers = {"X-Processing-Key": module.CLIENT_KEY}
    worker_headers = {"X-Processing-Key": module.WORKER_KEY}
    assert client.post("/processing/jobs", content=b"song").status_code == 403
    assert client.post("/processing/worker/claim", headers=client_headers).status_code == 403
    ticket = client.post("/processing/jobs", content=b"song", headers=client_headers).json()
    route = "/processing/jobs/" + ticket["jobId"]
    owner = {**client_headers, "X-Job-Key": ticket["jobKey"]}
    assert client.get(route, headers={**owner, "X-Job-Key": "wrong"}).status_code == 404
    assert client.get(route + "/result", headers=owner).status_code == 409
    claim = client.post("/processing/worker/claim", headers=worker_headers).json()["job"]
    worker = {**worker_headers, "X-Job-Key": claim["jobKey"]}
    worker_route = "/processing/worker/jobs/" + ticket["jobId"]
    assert client.post("/processing/worker/claim", headers=worker_headers).json()["job"] is None
    progress = {"stage": "ForcedAlignment", "stageProgress": 0.5, "overallProgress": 0.6}
    assert client.post(worker_route + "/heartbeat", headers=worker, json=progress).status_code == 200
    assert client.get(route, headers=owner).json()["progress"] == progress
    assert client.put(worker_route + "/result", content=b"ready", headers=worker).status_code == 204
    assert client.get(route + "/result", headers=owner).content == b"ready"
    assert client.delete(route, headers=owner).status_code == 204
    assert not (module.ROOT / ticket["jobId"]).exists()


def test_relay_enforces_free_transfer_limit_before_upload(relay, monkeypatch):
    module, client = relay
    monkeypatch.setattr(module, "MONTHLY_EGRESS", 4095)
    response = client.post(
        "/processing/jobs", content=b"song", headers={"X-Processing-Key": module.CLIENT_KEY}
    )
    assert response.status_code == 429
    with module.database() as db:
        assert db.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0


@pytest.mark.parametrize("cancelled", [False, True])
def test_worker_runs_complete_song_in_disposable_subprocess(tmp_path, monkeypatch, cancelled):
    from types import SimpleNamespace

    from backend.remote_worker import execute

    incoming, sessions = tmp_path / "incoming", tmp_path / "sessions"
    incoming.mkdir()
    sessions.mkdir()
    cancel = threading.Event()
    payload = {"protocolVersion": 1, "action": "process-song", "session": "a" * 32}

    def run(self, command, *, timeout_seconds, cancel):
        assert command[1:5] == ["-B", "-m", "backend.remote_worker", "--process-song"]
        assert timeout_seconds == 90 * 60
        assert cancel is cancellation
        if cancelled:
            from backend.domain_errors import ConflictError

            raise ConflictError("JobCancelled", "Cancelled")
        output = Path(command[-1])
        (output / "output.json").write_text('{"protocolVersion":1}', encoding="utf-8")
        for name in ["instrumental.flac", "vocals.flac", "melody.flac", "lyrics.json"]:
            (output / name).write_bytes(b"ready")
        return SimpleNamespace(exit_code=0)

    cancellation = cancel
    monkeypatch.setattr("backend.remote_worker.ProcessRunner.run", run)
    if cancelled:
        with pytest.raises(DomainError) as error:
            execute(payload, incoming, sessions, cancel)
        assert error.value.code == "JobCancelled"
    else:
        response, files = execute(payload, incoming, sessions, cancel)
        assert response == {"protocolVersion": 1}
        assert set(files) == {"instrumental.flac", "vocals.flac", "melody.flac", "lyrics.json"}
        assert all(path.parent == incoming / "complete" for path in files.values())
    assert not list(sessions.iterdir())


@pytest.mark.parametrize(
    "status,code",
    [(403, "ProcessingAccessDenied"), (413, "ProcessingFileTooLarge"),
     (429, "ProcessingFreeLimitReached"), (507, "ProcessingStorageFull")],
)
def test_processing_limits_preserve_actionable_errors(status, code):
    with pytest.raises(DomainError) as error:
        ProcessingTransport.check(httpx.Response(status, json={"detail": "Limit reached"}))
    assert error.value.code == code


@pytest.mark.parametrize("cancelled", [False, True])
def test_transport_uploads_once_downloads_only_completed_result_and_cleans_job(tmp_path, cancelled):
    source, result = tmp_path / "source.zip", tmp_path / "result.zip"
    source.write_bytes(b"source bundle")
    cancel = threading.Event()
    requests, updates = [], []

    def relay(request):
        requests.append((request.method, request.url.path))
        assert request.headers["X-Processing-Key"] == "client-key"
        if request.method == "POST":
            assert request.read() == b"source bundle"
            return httpx.Response(201, json={"jobId": "job", "jobKey": "job-key"})
        assert request.headers["X-Job-Key"] == "job-key"
        if request.method == "DELETE":
            return httpx.Response(204)
        if request.url.path.endswith("/result"):
            return httpx.Response(200, content=b"completed project")
        return httpx.Response(200, json={
            "state": "running" if cancelled else "done",
            "progress": {"stage": "ForcedAlignment", "stageProgress": 1, "overallProgress": 1},
        })

    def progress(*update):
        updates.append(update)
        if cancelled:
            cancel.set()

    transport = ProcessingTransport("https://relay.example/processing", "client-key")
    transport.client.close()
    transport.client = httpx.Client(
        headers={"X-Processing-Key": "client-key"}, transport=httpx.MockTransport(relay)
    )
    try:
        if cancelled:
            with pytest.raises(DomainError) as error:
                transport.invoke(source, result, cancel, progress=progress)
            assert error.value.code == "JobCancelled"
            assert not result.exists()
        else:
            transport.invoke(source, result, cancel, progress=progress)
            assert result.read_bytes() == b"completed project"
        assert requests == [
            ("POST", "/processing/jobs"), ("GET", "/processing/jobs/job"),
            *([] if cancelled else [("GET", "/processing/jobs/job/result")]),
            ("DELETE", "/processing/jobs/job"),
        ]
        assert updates == [("ForcedAlignment", 1, 0.98)]
    finally:
        transport.close()


def test_processing_bundle_preserves_source_and_rejects_unsafe_artifacts(tmp_path):
    source = tmp_path / "source.mp3"
    source.write_bytes(b"original compressed audio")
    bundle = tmp_path / "request.zip"
    write_bundle(bundle, {"action": "process-song"}, {"source.mp3": source})
    output = tmp_path / "output"
    output.mkdir()
    assert read_bundle(bundle, output) == {"action": "process-song"}
    assert (output / "source.mp3").read_bytes() == source.read_bytes()
    with zipfile.ZipFile(bundle, "w") as archive:
        archive.writestr("payload.json", "{}")
        archive.writestr("../escaped.wav", b"unsafe")
    with pytest.raises(ValueError, match="Invalid processing bundle"):
        read_bundle(bundle, output)
    assert not (tmp_path / "escaped.wav").exists()
