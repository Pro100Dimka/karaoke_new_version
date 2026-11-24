from __future__ import annotations

import hashlib
from pathlib import Path
from threading import Event

import pytest

from backend.domain_errors import ConflictError
from backend.infrastructure.hashing import sha256_file
from backend.processing.job_manager import JobContext
from tests.helpers import wait_for_job
from tests.test_models import declare


@pytest.mark.parametrize("already_ready", [False, True])
def test_model_cancel_stops_checksum_reads_at_the_current_chunk(
    client, tmp_path, monkeypatch, already_ready
):
    payload = b"m" * (4 * 1024 * 1024 + 17)
    declare(client, "asr", "checkpoint", payload, tmp_path / "source.bin")
    if already_ready:
        previous = client.post("/models/asr/checkpoint/download").json()["jobId"]
        assert wait_for_job(client, previous)["state"] == "Succeeded"
        assert client.post("/models/asr/checkpoint/select").status_code == 200
    entered, allow_read = Event(), Event()
    reads = []
    handles = []
    open_path = Path.open

    class HeldReader:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.stream.close()

        def read(self, size):
            chunk = self.stream.read(size)
            reads.append(len(chunk))
            if len(reads) == 1:
                entered.set()
                assert allow_read.wait(5), "The cancellation request did not release the read"
            return chunk

    def observe_open(path, mode="r", *args, **kwargs):
        stream = open_path(path, mode, *args, **kwargs)
        if mode == "rb" and path.suffix == ".download":
            handles.append(stream)
            return HeldReader(stream)
        return stream

    with monkeypatch.context() as changes:
        changes.setattr(Path, "open", observe_open)
        started = client.post("/models/asr/checkpoint/download")
        assert started.status_code == 202, started.text
        identity = started.json()["jobId"]
        try:
            assert entered.wait(3), "Model verification did not begin reading"
            cancelled = client.post(f"/jobs/{identity}/cancel")
            assert cancelled.status_code == 200, cancelled.text
            assert cancelled.json()["state"] == "Cancelling"
        finally:
            allow_read.set()
        assert wait_for_job(client, identity)["state"] == "Cancelled"
    model = next(item for item in client.get("/models").json() if item["version"] == "checkpoint")
    root = client.app.state.container.models.download._storage.final_path("asr", "checkpoint")
    assert not list(root.parent.glob("*.download"))
    assert handles and all(stream.closed for stream in handles)
    if already_ready:
        assert model["state"] == "Ready" and model["selected"] is True
        assert root.read_bytes() == payload
    else:
        assert model["state"] == "Failed" and model["localPath"] is None
        assert not root.exists()
    print(f"ready={already_ready} verification_reads={len(reads)} bytes_read={sum(reads)}")
    assert reads == [1024 * 1024], "Cancellation continued reading the rest of the model"
    retry = client.post("/models/asr/checkpoint/download").json()["jobId"]
    assert wait_for_job(client, retry)["state"] == "Succeeded"
    assert root.read_bytes() == payload


@pytest.mark.parametrize("size", [0, 1, 1024 * 1024, 1024 * 1024 + 1, 2 * 1024 * 1024 + 17])
@pytest.mark.parametrize("cancellable", [False, True])
def test_file_hash_keeps_complete_checksum_and_the_one_argument_contract(
    tmp_path, size, cancellable
):
    payload = (b"hash-checksum" * (size // 13 + 1))[:size]
    path = tmp_path / "checksum.bin"
    path.write_bytes(payload)
    checkpoints = []
    result = (
        sha256_file(path, lambda: checkpoints.append(True)) if cancellable else sha256_file(path)
    )
    assert result == hashlib.sha256(payload).hexdigest()
    assert bool(checkpoints) is cancellable


def test_cancelled_file_hash_does_not_open_the_file(tmp_path, monkeypatch):
    cancel = Event()
    cancel.set()
    context = JobContext("verification", cancel, lambda *_args: None)

    def unexpected_open(*_args, **_kwargs):
        pytest.fail("Cancellation must be checked before opening the model")

    monkeypatch.setattr(Path, "open", unexpected_open)
    with pytest.raises(ConflictError) as caught:
        sha256_file(tmp_path / "not-opened.bin", context.ensure_not_cancelled)
    assert caught.value.code == "JobCancelled"


@pytest.mark.parametrize("payload", [b"", b"complete model bytes"])
def test_cancellation_at_eof_is_not_returned_as_a_successful_checksum(
    tmp_path, monkeypatch, payload
):
    path = tmp_path / "checksum.bin"
    path.write_bytes(payload)
    cancel = Event()
    context = JobContext("verification", cancel, lambda *_args: None)
    stream = path.open("rb")

    class CancelAtEof:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            stream.close()

        def read(self, size):
            chunk = stream.read(size)
            if not chunk:
                cancel.set()
            return chunk

    monkeypatch.setattr(Path, "open", lambda *_args, **_kwargs: CancelAtEof())
    with pytest.raises(ConflictError) as caught:
        sha256_file(path, context.ensure_not_cancelled)
    assert caught.value.code == "JobCancelled"
    assert stream.closed
