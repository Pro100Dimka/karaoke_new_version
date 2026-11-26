from __future__ import annotations

import threading
import zipfile
import importlib.util
import sys
from pathlib import Path

import httpx
import pytest

from backend.domain_errors import DomainError
from backend.infrastructure.processing_transport import (
    ProcessingTransport,
    read_bundle,
    write_bundle,
)


@pytest.fixture
def relay(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("AD_VOICE_PROCESSING_DATA", str(tmp_path / "relay"))
    monkeypatch.setenv("AD_VOICE_PROCESSING_TOKEN", "client-key-" * 4)
    monkeypatch.setenv("AD_VOICE_PROCESSING_WORKER_TOKEN", "worker-key-" * 4)
    import sqlite3
    from backend.social.codes import device_key

    accounts = tmp_path / "social.sqlite3"
    with sqlite3.connect(accounts) as db:
        db.execute("CREATE TABLE accounts (device_key TEXT)")
        db.execute("INSERT INTO accounts VALUES (?)", (device_key("privacy-device-" * 4),))
    monkeypatch.setenv("AD_VOICE_PROCESSING_ACCOUNT_DB", str(accounts))
    spec = importlib.util.spec_from_file_location(
        "processing_relay_test", Path(__file__).parents[2] / "scripts/processing-server.py"
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    from backend.infrastructure.transfer_consent import CONSENT_VERSION
    from backend.social.codes import device_participant_id

    participant = device_participant_id("privacy-device-" * 4)
    for purpose in ["online", "processing"]:
        module.CONSENTS.record(participant, purpose, True, CONSENT_VERSION)
    declaration = module.CONSENTS.declare(
        participant, "processing", "processing-test", "nonpersonal", ""
    )
    with TestClient(
        module.app,
        headers={
            "X-AD-Voice-Device": "privacy-device-" * 4,
            "X-AD-Voice-File-Declaration": declaration,
        },
    ) as client:
        yield module, client


def test_account_erasure_waits_for_worker_and_removes_only_owned_processing_data(relay, tmp_path):
    from backend.infrastructure.processing_erasure import ProcessingErasure
    from backend.remote_worker import _erase_accounts
    from backend.social.codes import device_participant_id

    module, client = relay
    participant = device_participant_id("privacy-device-" * 4)
    headers = {"X-Processing-Key": module.CLIENT_KEY}
    ticket = client.post("/processing/jobs", content=b"private song", headers=headers).json()
    erasure = ProcessingErasure(module.ROOT)
    with pytest.raises(DomainError, match="processing") as pending:
        erasure.erase((participant,))
    assert pending.value.code == "ProcessingErasurePending"
    worker = {"X-Processing-Key": module.WORKER_KEY}
    claim = client.post("/processing/worker/claim", headers=worker).json()
    assert claim["erasures"] == [participant]
    root = tmp_path / "worker"
    owned, kept = root / "sessions" / participant, root / "sessions" / ("f" * 32)
    for directory in [owned, kept]:
        directory.mkdir(parents=True)
        (directory / "voice.wav").write_bytes(b"private voice")

    class Transport:
        def request(self, method, path):
            response = client.request(method, "/processing" + path, headers=worker)
            response.raise_for_status()
            return response

    _erase_accounts(Transport(), root, claim["erasures"])
    erasure.erase((participant,))
    assert not owned.exists()
    assert kept.exists()
    assert not (module.ROOT / ticket["jobId"]).exists()
    with module.database() as db:
        assert db.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0
    assert (
        client.post("/processing/jobs", content=b"late upload", headers=headers).status_code == 403
    )


def test_erasure_cannot_be_acknowledged_while_an_upload_can_still_write(relay, monkeypatch):
    import anyio
    from concurrent.futures import ThreadPoolExecutor
    from backend.infrastructure.processing_erasure import ProcessingErasure
    from backend.social.codes import device_participant_id

    module, client = relay
    started, release = threading.Event(), threading.Event()

    async def upload(request, path, expected, allowed):
        allowed()
        path.write_bytes(b"private upload")
        started.set()
        await anyio.to_thread.run_sync(release.wait)

    monkeypatch.setattr(module, "upload", upload)
    participant = device_participant_id("privacy-device-" * 4)
    erasure = ProcessingErasure(module.ROOT)
    worker = {"X-Processing-Key": module.WORKER_KEY}
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(
            client.post,
            "/processing/jobs",
            content=b"private upload",
            headers={"X-Processing-Key": module.CLIENT_KEY},
        )
        try:
            assert started.wait(5)
            with pytest.raises(DomainError):
                erasure.erase((participant,))
            assert (
                client.post(
                    "/processing/worker/erasures/" + participant, headers=worker
                ).status_code
                == 409
            )
        finally:
            release.set()
        assert pending.result(timeout=5).status_code == 409
    assert (
        client.post("/processing/worker/erasures/" + participant, headers=worker).status_code == 204
    )
    erasure.erase((participant,))


def test_account_api_does_not_report_deletion_until_processing_acknowledges(relay, tmp_path):
    from fastapi.testclient import TestClient
    from backend.api.room_server_app import create_room_server_app
    from backend.social.codes import device_participant_id

    module, client = relay
    secret = "privacy-device-" * 4
    participant = device_participant_id(secret)
    client.post(
        "/processing/jobs", content=b"private job", headers={"X-Processing-Key": module.CLIENT_KEY}
    ).raise_for_status()
    app = create_room_server_app(
        relay_port=0,
        room_database=tmp_path / "accounts/rooms.sqlite3",
        project_root=tmp_path / "projects",
        diagnostics_root=tmp_path / "logs",
        processing_root=module.ROOT,
    )
    headers = {"X-AD-Voice-Device": secret}
    with TestClient(app) as accounts:
        account = accounts.get("/social/me", headers=headers).json()
        response = accounts.request(
            "DELETE", "/social/me", headers=headers, json={"accountId": account["accountId"]}
        )
        assert response.status_code == 409
        assert response.json()["code"] == "ProcessingErasurePending"
        assert accounts.get("/social/me", headers=headers).status_code == 200
        client.post(
            "/processing/worker/erasures/" + participant,
            headers={"X-Processing-Key": module.WORKER_KEY},
        ).raise_for_status()
        assert (
            accounts.request(
                "DELETE", "/social/me", headers=headers, json={"accountId": account["accountId"]}
            ).status_code
            == 204
        )
        assert accounts.get("/social/me", headers=headers).status_code == 403


@pytest.mark.parametrize("cancel_running", [False, "ack", "lease", "worker"])
def test_relay_separates_credentials_and_returns_result_only_after_completion(
    relay, cancel_running, tmp_path, monkeypatch
):
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
    assert (
        client.post(worker_route + "/heartbeat", headers=worker, json=progress).status_code == 200
    )
    assert client.get(route, headers=owner).json()["progress"] == progress
    if cancel_running:
        assert client.delete(route, headers=owner).status_code == 204
        if cancel_running == "lease":
            module.cleanup()
            with module.database() as db:
                assert (
                    db.execute(
                        "SELECT reserved FROM jobs WHERE id=?", (ticket["jobId"],)
                    ).fetchone()[0]
                    > 0
                )
                db.execute("UPDATE jobs SET deadline=0 WHERE id=?", (ticket["jobId"],))
            module.cleanup()
        elif cancel_running == "worker":
            from types import SimpleNamespace
            import backend.remote_worker as remote

            root = tmp_path / "worker"
            (root / "temp").mkdir(parents=True)
            (root / "sessions").mkdir()

            def execute(payload, incoming, sessions, cancel):
                cancel.set()
                return {}, {}

            monkeypatch.setattr(remote, "execute", execute)
            monkeypatch.setattr(
                remote,
                "run_in_background",
                lambda *args: SimpleNamespace(join=lambda **kwargs: None),
            )
            transport = SimpleNamespace(
                download=lambda path, output, headers, cancel: write_bundle(output, {}, {}),
                request=lambda method, path, **kwargs: client.request(
                    method, "/processing" + path, headers=worker
                ),
            )
            remote.run_job(transport, claim, root, threading.Event())
        else:
            for _ in range(2):
                assert client.post(worker_route + "/failed", headers=worker).status_code == 204
        with module.database() as db:
            assert (
                db.execute("SELECT reserved FROM jobs WHERE id=?", (ticket["jobId"],)).fetchone()[0]
                == 0
            )
        assert not (module.ROOT / ticket["jobId"]).exists()
        assert client.get(route, headers=owner).json()["state"] == "cancelled"
        return
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


def test_processing_requires_current_consent_and_a_fresh_declaration_after_withdrawal(relay):
    from backend.infrastructure.transfer_consent import CONSENT_VERSION
    from backend.social.codes import device_participant_id

    module, client = relay
    owner = device_participant_id("privacy-device-" * 4)
    headers = {"X-Processing-Key": module.CLIENT_KEY}
    module.CONSENTS.record(owner, "processing", False, CONSENT_VERSION)
    assert (
        client.post("/processing/jobs", headers=headers, content=b"not admitted").status_code == 403
    )
    module.CONSENTS.record(owner, "processing", True, CONSENT_VERSION)
    assert (
        client.post("/processing/jobs", headers=headers, content=b"old declaration").status_code
        == 403
    )
    with module.database() as db:
        assert db.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0
    declaration = module.CONSENTS.declare(owner, "processing", "new-operation", "nonpersonal", "")
    ticket = client.post(
        "/processing/jobs",
        headers={**headers, "X-AD-Voice-File-Declaration": declaration},
        content=b"admitted",
    ).json()
    worker = {"X-Processing-Key": module.WORKER_KEY}
    claim = client.post("/processing/worker/claim", headers=worker).json()["job"]
    worker["X-Job-Key"] = claim["jobKey"]
    route = "/processing/worker/jobs/" + ticket["jobId"]
    module.CONSENTS.record(owner, "processing", False, CONSENT_VERSION)
    assert client.get(route + "/input", headers=worker).status_code == 409
    assert client.post(route + "/heartbeat", headers=worker).json()["state"] == "cancelled"
    assert client.put(route + "/result", headers=worker, content=b"late result").status_code == 409
    assert client.post(route + "/failed", headers=worker).status_code == 204
    assert not (module.ROOT / ticket["jobId"]).exists()


def test_withdrawn_queued_job_is_never_claimed(relay):
    from backend.infrastructure.transfer_consent import CONSENT_VERSION
    from backend.social.codes import device_participant_id

    module, client = relay
    owner = device_participant_id("privacy-device-" * 4)
    ticket = client.post(
        "/processing/jobs", headers={"X-Processing-Key": module.CLIENT_KEY}, content=b"queued"
    ).json()
    module.CONSENTS.record(owner, "processing", False, CONSENT_VERSION)
    response = client.post(
        "/processing/worker/claim", headers={"X-Processing-Key": module.WORKER_KEY}
    )
    assert response.json()["job"] is None
    module.cleanup()
    assert not (module.ROOT / ticket["jobId"]).exists()


def test_processing_provider_binds_declaration_to_one_job_and_stops_after_local_withdrawal(
    tmp_path, monkeypatch
):
    import json
    from backend.infrastructure import oracle_ai_provider as remote
    from backend.infrastructure.transfer_consent import CONSENT_VERSION
    from backend.processing.preflight import authorize_upload

    url = "http://127.0.0.1:8081"
    path = tmp_path / "transfer-consents.json"
    choices = {purpose: {"enabled": True, "pending": False} for purpose in ["online", "processing"]}
    path.write_text(
        json.dumps({"version": CONSENT_VERSION, "origin": url, "choices": choices}),
        encoding="utf-8",
    )
    monkeypatch.setenv("AD_VOICE_TRANSFER_CONSENT_FILE", str(path))
    monkeypatch.setattr(remote, "processing_connection", lambda: (url + "/processing", "key" * 16))
    monkeypatch.setattr(
        remote, "account_identity", lambda *_: {"secret": "a" * 64, "enabled": True}
    )
    sent = []

    class Transport:
        def __init__(self, url, token):
            self.url = url

        def invoke(self, source, result, cancel, **kwargs):
            sent.append(kwargs["declaration"])
            write_bundle(result, {"protocolVersion": 1}, {})

        def close(self):
            pass

    monkeypatch.setattr(remote, "ProcessingTransport", Transport)
    provider = remote.OracleAiProvider(tmp_path / "temp")
    cancel = threading.Event()
    with authorize_upload((provider, provider), "current-job-ticket", cancel):
        assert provider._invoke("prepare", {}, {}, cancel)["protocolVersion"] == 1
        choices["processing"]["enabled"] = False
        path.write_text(
            json.dumps({"version": CONSENT_VERSION, "origin": url, "choices": choices}),
            encoding="utf-8",
        )
        with pytest.raises(DomainError) as refused:
            provider._invoke("prepare", {}, {}, cancel)
        assert refused.value.code == "TransferConsentRequired"
    assert sent == ["current-job-ticket"]
    choices["processing"]["enabled"] = True
    path.write_text(
        json.dumps({"version": CONSENT_VERSION, "origin": url, "choices": choices}),
        encoding="utf-8",
    )
    with pytest.raises(DomainError):
        provider._invoke("prepare", {}, {}, cancel)


@pytest.mark.parametrize("cancelled", [False, True])
@pytest.mark.parametrize("compact", [False, True])
def test_worker_runs_complete_song_in_disposable_subprocess(
    tmp_path, monkeypatch, cancelled, compact
):
    import os
    from types import SimpleNamespace

    import numpy as np
    import soundfile as sf

    from backend import remote_worker
    from backend.remote_worker import execute
    from backend.processing import worker_song
    from backend.processing.domain import JobState
    from backend.serialization import loads_object

    with monkeypatch.context() as setup:
        setup.setattr(os, "environ", dict(os.environ))
        setup.setattr(
            remote_worker, "__file__", str(tmp_path / "python" / "backend" / "remote_worker.py")
        )
        root = tmp_path / "worker" / "ProcessingWorker"
        models = root.parent / "AD Voice" / "backend-data" / "models"
        for spec in remote_worker.CATALOG:
            model = models / spec.model_id / spec.version / "model.bin"
            model.parent.mkdir(parents=True)
            model.write_bytes(b"model")
        setup.setenv("AD_VOICE_PROCESSING_WORKER_DATA", str(root))
        setup.setattr(sys, "argv", ["remote_worker", "--stop"])
        setup.setattr(remote_worker, "dotenv_values", lambda _: {})
        remote_worker.main()
        assert (root / "stop.request").is_file()
        setup.setattr(
            remote_worker.SystemRuntimeProbe,
            "inspect",
            lambda _: SimpleNamespace(cuda_available=True, gpu_name="GPU"),
        )
        assert remote_worker._configure_worker(root, {}) == "GPU"
        assert Path(os.environ["AD_VOICE_MODELS"]) == models
        assert Path(os.environ["TEMP"]) == root / "temp"
        assert Path(os.environ["AD_VOICE_DATA"]) == root

    incoming, sessions = tmp_path / "incoming", tmp_path / "sessions"
    incoming.mkdir()
    sessions.mkdir()
    cancel = threading.Event()
    payload = {
        "protocolVersion": 1,
        "action": "process-song",
        "session": "a" * 32,
        "source": "source.mp3",
        "song": {"title": "Song", "artist": "Singer", "language": "Auto"},
        "mode": "Auto",
        "onlineLyrics": False,
        "progressPath": str(tmp_path / "progress.json"),
    }
    if compact:
        payload["compactProjectAudio"] = True
    (incoming / "source.mp3").write_bytes(b"source")
    monkeypatch.setenv("AD_VOICE_MODELS", str(tmp_path / "models"))
    shutdown = []
    expected_audio = {}
    expected_bytes = {}

    def build_app(roots):
        runtime = roots.app
        runtime.mkdir(parents=True, exist_ok=True)
        samples = np.sin(np.arange(4410) * 0.05).astype(np.float32) * 0.05
        stereo = np.column_stack((samples, samples * 0.7))
        artifacts = {}
        for logical in ("instrumental", "referenceVocal", "melody"):
            source = runtime / (logical + (".flac" if logical == "melody" else ".mp3"))
            sf.write(source, stereo, 44100)
            artifacts[logical] = source
            expected_audio[logical] = sf.read(source, dtype="float32", always_2d=True)
            expected_bytes[logical] = source.read_bytes()
        artifacts["lyricsSync"] = runtime / "lyrics.json"
        artifacts["lyricsSync"].write_text("{}")
        song = SimpleNamespace(song_id="song", active_revision=1)
        job = SimpleNamespace(
            job_id="job",
            terminal=True,
            state=JobState.SUCCEEDED,
            stage="Complete",
            stage_progress=1,
            overall_progress=1,
            report={},
        )
        projects = SimpleNamespace(
            load_manifest=lambda *args: SimpleNamespace(provenance={}),
            artifact_path=lambda song_id, revision, logical: artifacts[logical],
        )
        monkeypatch.setattr(worker_song, "LocalProjectStorage", lambda roots: projects)
        return SimpleNamespace(
            songs=SimpleNamespace(
                import_song=SimpleNamespace(execute=lambda request: song),
                start_processing=SimpleNamespace(execute=lambda *args, **kwargs: job),
                get_song=SimpleNamespace(execute=lambda song_id: song),
            ),
            system=SimpleNamespace(jobs=SimpleNamespace(get=lambda job_id: job)),
            shutdown=lambda: shutdown.append(True),
        )

    monkeypatch.setattr(worker_song, "_build_app", build_app)

    def run(self, command, *, timeout_seconds, cancel):
        assert command[1:5] == ["-B", "-m", "backend.remote_worker", "--process-song"]
        assert timeout_seconds == 90 * 60
        assert cancel is cancellation
        if cancelled:
            from backend.domain_errors import ConflictError

            raise ConflictError("JobCancelled", "Cancelled")
        output = Path(command[-1])
        worker_song.process_song_task(incoming, output)
        assert not (output / "runtime").exists()
        return SimpleNamespace(exit_code=0)

    cancellation = cancel
    monkeypatch.setattr("backend.remote_worker.ProcessRunner.run", run)
    if cancelled:
        with pytest.raises(DomainError) as error:
            execute(payload, incoming, sessions, cancel)
        assert error.value.code == "JobCancelled"
    else:
        response, files = execute(payload, incoming, sessions, cancel)
        audio_names = {
            "instrumental": "instrumental.mp3" if compact else "instrumental.flac",
            "referenceVocal": "vocals.mp3" if compact else "vocals.flac",
            "melody": "melody.flac",
        }
        assert response == {
            "protocolVersion": 1,
            "report": {},
            "provenance": {},
            **({"audioFiles": audio_names} if compact else {}),
        }
        assert set(files) == {*audio_names.values(), "lyrics.json"}
        for logical, filename in audio_names.items():
            target = files[filename]
            expected, rate = expected_audio[logical]
            actual, actual_rate = sf.read(target, dtype="float32", always_2d=True)
            assert actual_rate == rate
            assert actual.shape == expected.shape
            if compact or logical == "melody":
                assert target.read_bytes() == expected_bytes[logical]
            else:
                assert sf.info(target).format == "FLAC"
                np.testing.assert_allclose(actual, expected, rtol=0, atol=2**-23)
        assert all(path.parent == incoming / "complete" for path in files.values())
        assert shutdown == [True]
        assert loads_object((tmp_path / "progress.json").read_text())["overallProgress"] == 1
    assert not list(sessions.iterdir())


@pytest.mark.parametrize(
    "status,code",
    [
        (403, "ProcessingAccessDenied"),
        (413, "ProcessingFileTooLarge"),
        (429, "ProcessingFreeLimitReached"),
        (507, "ProcessingStorageFull"),
    ],
)
def test_processing_limits_preserve_actionable_errors(status, code):
    with pytest.raises(DomainError) as error:
        ProcessingTransport.check(httpx.Response(status, json={"detail": "Limit reached"}))
    assert error.value.code == code


@pytest.mark.parametrize("cancelled", [False, True])
def test_transport_uploads_once_downloads_only_completed_result_and_cleans_job(
    tmp_path, cancelled, monkeypatch
):
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(key, raising=False)
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
        return httpx.Response(
            200,
            json={
                "state": "running" if cancelled else "done",
                "progress": {"stage": "ForcedAlignment", "stageProgress": 1, "overallProgress": 1},
            },
        )

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
            ("POST", "/processing/jobs"),
            ("GET", "/processing/jobs/job"),
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
