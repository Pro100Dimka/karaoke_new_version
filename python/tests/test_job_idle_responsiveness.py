from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from backend.domain_errors import ConflictError
from backend.infrastructure.sql_jobs import SqlJobRepository
from backend.processing.domain import JobState, JobType
from tests.conftest import write_wav
from tests.helpers import import_song


@pytest.mark.parametrize("control", ["progress", "cancel", "finish"])
def test_song_cleanup_does_not_block_an_unrelated_running_job(
    client, tmp_path, monkeypatch, control
):
    source = tmp_path / "song.wav"
    write_wav(source, seconds=0.125)
    song_id = import_song(client, source)["songId"]
    app = client.app.state.container
    manager = app.system.jobs
    storage = app.songs.delete_song._storage
    finalize = storage.finalize_quarantine
    cleaning, release_cleanup, running, begin_control, control_done, finish_work = (
        Event() for _ in range(6)
    )

    def held_cleanup(path):
        cleaning.set()
        assert release_cleanup.wait(10), "The control request did not release song cleanup"
        finalize(path)

    def work(context):
        running.set()
        assert begin_control.wait(10)
        if control == "progress":
            context.progress("Unrelated song", 0.5, 0.5)
            control_done.set()
            assert finish_work.wait(10)
        elif control == "cancel":
            assert context.cancel.wait(10)
            context.ensure_not_cancelled()

    monkeypatch.setattr(storage, "finalize_quarantine", held_cleanup)
    job = manager.start(
        JobType.SONG_PROCESSING,
        work,
        entity_id="another-song",
        on_finally=control_done.set if control == "finish" else None,
    )
    assert running.wait(3)
    with ThreadPoolExecutor(max_workers=2) as requests:
        deleting = requests.submit(client.delete, f"/songs/{song_id}")
        cancelling = None
        try:
            assert cleaning.wait(3), "Deletion did not reach recursive quarantine cleanup"
            begin_control.set()
            if control == "cancel":

                def cancel():
                    result = client.post(f"/jobs/{job.job_id}/cancel")
                    control_done.set()
                    return result

                cancelling = requests.submit(cancel)
            responded_while_cleaning = control_done.wait(1)
            assert not release_cleanup.is_set()
        finally:
            release_cleanup.set()
            begin_control.set()
            finish_work.set()
        deleted = deleting.result(timeout=3)
        if cancelling is not None:
            cancelled = cancelling.result(timeout=3)
            assert cancelled.status_code == 200, cancelled.text
            assert cancelled.json()["state"] == JobState.CANCELLING.value
    assert deleted.status_code == 204, deleted.text
    assert responded_while_cleaning, f"Running job {control} waited for unrelated file cleanup"
    if control == "finish":
        assert manager.get(job.job_id).state is JobState.SUCCEEDED


@pytest.mark.parametrize("fail_action", [False, True])
def test_cleanup_excludes_new_job_rows_and_submission_until_it_finishes(
    client, monkeypatch, fail_action
):
    manager = client.app.state.container.system.jobs
    cleaning, release_cleanup, attempting, persisted, executed = (Event() for _ in range(5))
    add = SqlJobRepository.add

    def observe_add(repository, job):
        add(repository, job)
        persisted.set()

    def cleanup():
        cleaning.set()
        assert release_cleanup.wait(10)
        if fail_action:
            raise OSError("Cleanup could not remove a file")

    def start():
        attempting.set()
        return manager.start(JobType.SONG_IMPORT, lambda _context: executed.set())

    monkeypatch.setattr(SqlJobRepository, "add", observe_add)
    with ThreadPoolExecutor(max_workers=2) as workers:
        cleaning_files = workers.submit(manager.run_when_idle, cleanup)
        starting = None
        try:
            assert cleaning.wait(3)
            starting = workers.submit(start)
            assert attempting.wait(3)
            persisted_while_cleaning = persisted.wait(0.2)
            assert not executed.is_set()
        finally:
            release_cleanup.set()
        if fail_action:
            with pytest.raises(OSError, match="could not remove"):
                cleaning_files.result(timeout=3)
        else:
            cleaning_files.result(timeout=3)
        assert starting is not None
        job = starting.result(timeout=3)
        assert executed.wait(3)
    assert not persisted_while_cleaning, "A blocked submission exposed a premature Queued row"
    assert persisted.is_set()
    assert manager.get(job.job_id).state in {JobState.RUNNING, JobState.SUCCEEDED}


def test_cleanup_excludes_input_preparation_and_preserves_its_reservation(client):
    manager = client.app.state.container.system.jobs
    cleaning, release_cleanup, attempting, preparing, release_preparation = (
        Event() for _ in range(5)
    )

    def cleanup():
        cleaning.set()
        assert release_cleanup.wait(10)

    def prepare():
        attempting.set()
        with manager.prepare_submission():
            preparing.set()
            assert release_preparation.wait(10)

    with ThreadPoolExecutor(max_workers=2) as workers:
        cleaning_files = workers.submit(manager.run_when_idle, cleanup)
        preparing_inputs = None
        try:
            assert cleaning.wait(3)
            preparing_inputs = workers.submit(prepare)
            assert attempting.wait(3)
            assert not preparing.wait(0.2), "Input preparation raced with file removal"
            release_cleanup.set()
            cleaning_files.result(timeout=3)
            assert preparing.wait(3)
            for allowed in ((), (JobType.SONG_IMPORT,)):
                with pytest.raises(ConflictError):
                    manager.run_when_idle(lambda: None, allow_job_types=allowed)
        finally:
            release_cleanup.set()
            release_preparation.set()
        cleaning_files.result(timeout=3)
        assert preparing_inputs is not None
        preparing_inputs.result(timeout=3)
    # Nested idle checks and preparation keep their existing same-thread behavior.
    entered = []

    def nested_action():
        manager.run_when_idle(lambda: entered.append("nested"))
        with manager.prepare_submission():
            entered.append("prepared")

    with ThreadPoolExecutor(max_workers=1) as workers:
        workers.submit(manager.run_when_idle, nested_action).result(timeout=3)
    assert entered == ["nested", "prepared"]


def test_shutdown_rejects_a_submission_waiting_for_cleanup_without_leaking_ownership(client):
    manager = client.app.state.container.system.jobs
    cleaning, release_cleanup, attempting, executed = (Event() for _ in range(4))

    def cleanup():
        cleaning.set()
        assert release_cleanup.wait(10)

    def start():
        attempting.set()
        return manager.start(JobType.SONG_IMPORT, lambda _context: executed.set())

    with ThreadPoolExecutor(max_workers=3) as workers:
        cleaning_files = workers.submit(manager.run_when_idle, cleanup)
        starting = None
        try:
            assert cleaning.wait(3)
            starting = workers.submit(start)
            assert attempting.wait(3)
            workers.submit(manager._executor.shutdown).result(timeout=3)
            assert not executed.is_set()
        finally:
            release_cleanup.set()
        cleaning_files.result(timeout=3)
        assert starting is not None
        with pytest.raises(ConflictError) as rejected:
            starting.result(timeout=3)
    assert rejected.value.code == "BackendStopping"
    jobs = manager.list(limit=100, offset=0, job_type=JobType.SONG_IMPORT)
    assert len(jobs) == 1 and jobs[0].state is JobState.FAILED
    assert jobs[0].error["code"] == "BackendStopping"
    assert not manager._active_job_types and not executed.is_set()
    manager.run_when_idle(lambda: None)
