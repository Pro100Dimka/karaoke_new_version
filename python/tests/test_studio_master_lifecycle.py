from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from shutil import copyfile
from threading import Event
from types import SimpleNamespace

import pytest

from backend.domain_errors import DomainError
from backend.infrastructure.recording_archive import RecordingArchive
from backend.recordings.studio_audio import StudioMasterBalance
from tests.conftest import app_client, write_wav
from tests.helpers import import_song, wait_for_job

pytestmark = pytest.mark.integration


@pytest.fixture
def mastering(tmp_path, monkeypatch):
    # Exercise real requests, jobs and persistence; DSP is unrelated to admission/publication.
    monkeypatch.setattr(RecordingArchive, "_step", lambda self: self._cancel.wait(0.05))
    reference = tmp_path / "reference.wav"
    write_wav(reference, seconds=0.1)
    with app_client(tmp_path / "runtime") as client:
        song = import_song(client, reference)
        target = client.post("/recordings/target").json()
        audio = Path(target["filePath"])
        write_wav(audio, seconds=0.1)
        for suffix in (".dry.wav", ".vocal.wav", ".backing.wav"):
            copyfile(audio, Path(str(audio) + suffix))
        registered = client.post(
            "/recordings",
            json={
                **target,
                "duration": 0.1,
                "sampleRate": 16000,
                "channels": 1,
                "createdAt": datetime.now(UTC).isoformat(),
                "songId": song["songId"],
                "songRevision": song["activeRevision"],
            },
        )
        assert registered.status_code == 201, registered.text
        container = client.app.state.container
        service = container.recordings.start_studio_master
        service._projects = SimpleNamespace(artifact_path=lambda *_: reference)
        monkeypatch.setattr(service, "_stems", lambda take: (take.file_path, take.file_path))
        monkeypatch.setattr(service, "_render", _render)
        yield SimpleNamespace(
            client=client, service=service, audio=audio, take=registered.json(), container=container
        )


def _render(recording, stems, exact_stems, output, context):
    context.ensure_not_cancelled()
    copyfile(recording.file_path, output)
    return StudioMasterBalance(0, -20, -20, -20, -20, 1)


def _start(session, identity=None):
    identity = identity or session.take["recordingId"]
    response = session.client.post(f"/recordings/{identity}/studio-master")
    assert response.status_code == 202, response.text
    return response.json()["jobId"]


@pytest.mark.parametrize("through_existing_master", [False, True])
def test_repeated_master_request_follows_one_job_for_the_original_take(
    mastering,
    monkeypatch,
    through_existing_master,
):
    session = mastering
    requested = session.take["recordingId"]
    if through_existing_master:
        source = session.container.recordings.get.execute(requested)
        prior = session.service._publisher.execute(source, session.audio, {})
        requested = prior.recording_id
    before = session.client.get("/recordings").json()["total"]
    original = session.audio.read_bytes()
    entered, release = Event(), Event()
    renders = []

    def blocked(*args):
        renders.append(args[0].recording_id)
        entered.set()
        assert release.wait(5), "The duplicate request did not finish"
        return _render(*args)

    monkeypatch.setattr(session.service, "_render", blocked)
    first = _start(session)
    try:
        assert entered.wait(5), "Master did not start rendering"
        repeated = _start(session, requested)
    finally:
        release.set()
    for identity in {first, repeated}:
        assert wait_for_job(session.client, identity)["state"] == "Succeeded"
    assert repeated == first, "Repeated requests must follow the existing original's job"
    assert renders == [session.take["recordingId"]]
    assert session.client.get("/recordings").json()["total"] == before + 1
    assert session.audio.read_bytes() == original


@pytest.mark.parametrize("first_state", ["Succeeded", "Cancelled", "Failed"])
def test_terminal_master_can_be_requested_again_without_overwriting_the_take(
    mastering,
    monkeypatch,
    first_state,
):
    session = mastering
    original = session.audio.read_bytes()
    entered, release = Event(), Event()
    calls = []

    def controlled(*args):
        calls.append(args[0].recording_id)
        if len(calls) == 1:
            entered.set()
            assert release.wait(5), "The first request was not released"
            if first_state == "Failed":
                raise DomainError("StudioMasterFailed", "Injected rendering failure", 422)
        return _render(*args)

    monkeypatch.setattr(session.service, "_render", controlled)
    first = _start(session)
    try:
        assert entered.wait(5), "Master did not enter the renderer"
        if first_state == "Cancelled":
            assert session.client.post(f"/jobs/{first}/cancel").status_code == 200
    finally:
        release.set()
    assert wait_for_job(session.client, first)["state"] == first_state
    next_job = _start(session)
    assert next_job != first
    assert wait_for_job(session.client, next_job)["state"] == "Succeeded"
    assert len(calls) == 2
    assert session.client.get("/recordings").json()["total"] == 2 + (first_state == "Succeeded")
    assert session.audio.read_bytes() == original
    assert not tuple(session.container.roots.temp.glob("studio-*"))


def test_archival_notification_failure_does_not_hide_a_committed_master(mastering, monkeypatch):
    session = mastering
    original = session.audio.read_bytes()
    notifications = []

    def unavailable(recording_id):
        notifications.append(recording_id)
        raise OSError("No space to write the background archival marker")

    session.container.recordings.register.set_ready_callback(unavailable)
    monkeypatch.setattr(session.service._publisher, "_on_completed", unavailable)
    job = wait_for_job(session.client, _start(session))
    assert job["state"] == "Succeeded", job
    saved = session.client.get(f"/recordings/{job['report']['recordingId']}").json()
    assert saved["sourceRecordingId"] == session.take["recordingId"]
    assert saved["fileStatus"] == "Ready"
    assert Path(saved["filePath"]).read_bytes() == original
    assert session.audio.read_bytes() == original
    assert session.client.get("/recordings").json()["total"] == 2
    assert notifications and set(notifications) == {saved["recordingId"]}


def test_deletion_cannot_remove_master_input_during_job_admission(mastering, monkeypatch):
    session = mastering
    original = session.audio.read_bytes()
    entered, release = Event(), Event()
    resolve = session.service._projects.artifact_path

    def paused(*args):
        if not entered.is_set():
            entered.set()
            assert release.wait(5), "Deletion did not finish while admission was paused"
        return resolve(*args)

    monkeypatch.setattr(session.service._projects, "artifact_path", paused)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(_start, session)
        try:
            assert entered.wait(5), "Admission did not reach project validation"
            deleted = session.client.delete(f"/recordings/{session.take['recordingId']}")
        finally:
            release.set()
        job_id = pending.result(timeout=5)
    job = wait_for_job(session.client, job_id)
    assert deleted.status_code == 409, deleted.text
    assert deleted.json()["code"] == "LibraryInUse"
    assert job["state"] == "Succeeded", job
    assert session.audio.read_bytes() == original
