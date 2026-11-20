import threading
from contextvars import ContextVar

import pytest

from backend.domain_errors import ConflictError, DomainError
from backend.processing.domain import JobState, JobType
from tests.conftest import app_client


def test_waiting_for_resources_keeps_a_worker_available_for_ordinary_jobs(tmp_path):
    running, release, waiting, ordinary_ran = (threading.Event() for _ in range(4))
    with app_client(tmp_path) as client:
        manager = client.app.state.container.system.jobs

        def held_work(_context):
            running.set()
            assert release.wait(5)

        def wait_for_resources(cancel):
            waiting.set()
            assert cancel.wait(5)

        manager.start(JobType.SONG_PROCESSING, held_work)
        queued = manager.start(JobType.SONG_PROCESSING, held_work, admit=wait_for_resources)
        try:
            assert running.wait(2) and waiting.wait(2)
            manager.start(JobType.SONG_IMPORT, lambda _context: ordinary_ran.set())
            assert ordinary_ran.wait(0.5), "Resource admission occupied the idle job worker"
            assert manager.get(queued.job_id).state is JobState.QUEUED
            assert manager._executor.stats()["workers"] == 2
            assert not release.is_set()
        finally:
            manager.cancel(queued.job_id)
            release.set()


def test_admission_context_and_cancel_identity_follow_the_job_to_finalization(tmp_path):
    lease = ContextVar("test_admission_lease", default=None)
    finished = threading.Event()
    observed = {}
    with app_client(tmp_path) as client:
        manager = client.app.state.container.system.jobs

        def admit(cancel):
            observed["token"] = lease.set("owned")
            observed["cancel"] = cancel
            observed["admission_thread"] = threading.current_thread()

        def work(context):
            observed["lease"] = lease.get()
            observed["same_cancel"] = context.cancel is observed["cancel"]
            observed["execution_thread"] = threading.current_thread()

        def finalize():
            observed["final_lease"] = lease.get()
            lease.reset(observed["token"])
            finished.set()

        job = manager.start(JobType.RECORDING_ANALYSIS, work, admit=admit, on_finally=finalize)
        assert finished.wait(2), "The admission ContextVar token could not be finalized"
        assert manager.get(job.job_id).state is JobState.SUCCEEDED
        assert observed["lease"] == observed["final_lease"] == "owned"
        assert observed["same_cancel"]
        assert observed["admission_thread"] is not observed["execution_thread"]
        assert lease.get() is None


def test_cancelled_admission_keeps_file_ownership_until_finalization_finishes(tmp_path):
    waiting, finalizing, release = (threading.Event() for _ in range(3))
    finalized, executed, idle = [], [], []
    with app_client(tmp_path) as client:
        manager = client.app.state.container.system.jobs

        def admit(cancel):
            waiting.set()
            assert cancel.wait(3)

        def finalize():
            finalizing.set()
            assert release.wait(3)
            finalized.append(True)

        job = manager.start(
            JobType.SONG_PROCESSING,
            lambda _context: executed.append(True),
            admit=admit,
            on_finally=finalize,
        )
        try:
            assert waiting.wait(2)
            manager.cancel(job.job_id)
            assert finalizing.wait(2)
            assert manager.get(job.job_id).state is JobState.CANCELLED
            for allowed in ((), (JobType.SONG_IMPORT,)):
                with pytest.raises(ConflictError):
                    manager.run_when_idle(lambda: idle.append(True), allow_job_types=allowed)
        finally:
            release.set()
            manager._executor.shutdown()
        manager.run_when_idle(lambda: idle.append(True))
        assert finalized == idle == [True]
        assert not executed and not manager._active_job_types


@pytest.mark.parametrize("unexpected", [False, True])
def test_failed_admission_settles_once_and_keeps_the_original_error(tmp_path, unexpected):
    finalized, executed = [], []
    finished = threading.Event()
    with app_client(tmp_path) as client:
        manager = client.app.state.container.system.jobs

        def admit(_cancel):
            if unexpected:
                raise RuntimeError("Admission probe failed")
            raise DomainError("ResourceUnavailable", "The resource is unavailable", 503)

        def finalize():
            finalized.append(True)
            finished.set()

        job = manager.start(
            JobType.SONG_PROCESSING,
            lambda _context: executed.append(True),
            admit=admit,
            on_finally=finalize,
        )
        assert finished.wait(2)
        manager._executor.shutdown()
        result = manager.get(job.job_id)
        assert result.state is JobState.FAILED
        assert result.error["code"] == ("InternalJobError" if unexpected else "ResourceUnavailable")
        assert finalized == [True] and not executed
        assert not manager._active_job_types


def test_job_cancelled_before_admission_reaches_its_finalizer_once(tmp_path):
    release, finished = threading.Event(), threading.Event()
    admitted, executed, finalized = [], [], []
    with app_client(tmp_path) as client:
        manager = client.app.state.container.system.jobs
        waiting = [threading.Event() for _ in range(manager._executor.stats()["workers"])]

        def first_admission(index, _cancel):
            waiting[index].set()
            assert release.wait(3)

        def finalize():
            finalized.append(True)
            finished.set()

        for index in range(len(waiting)):
            manager.start(
                JobType.SONG_PROCESSING,
                lambda _context: None,
                admit=lambda cancel, i=index: first_admission(i, cancel),
            )
        try:
            assert all(event.wait(2) for event in waiting)
            job = manager.start(
                JobType.SONG_PROCESSING,
                lambda _context: executed.append(True),
                admit=lambda cancel: admitted.append(cancel.is_set()),
                on_finally=finalize,
            )
            manager.cancel(job.job_id)
            assert not admitted
        finally:
            release.set()
        assert finished.wait(2)
        assert manager.get(job.job_id).state is JobState.CANCELLED
        assert admitted == finalized == [True] and not executed


def test_cancellation_after_admission_handoff_does_not_run_work(tmp_path, monkeypatch):
    started = [threading.Event(), threading.Event()]
    release, handed_off, finished = (threading.Event() for _ in range(3))
    executed, finalized = [], []
    with app_client(tmp_path) as client:
        manager = client.app.state.container.system.jobs

        def held_work(index, _context):
            started[index].set()
            assert release.wait(3)

        for index in range(2):
            manager.start(JobType.SONG_IMPORT, lambda context, i=index: held_work(i, context))
        enqueue = manager._executor._queue.put_nowait

        def observe_handoff(task):
            enqueue(task)
            handed_off.set()

        def finalize():
            finalized.append(True)
            finished.set()

        try:
            assert all(event.wait(2) for event in started)
            monkeypatch.setattr(manager._executor._queue, "put_nowait", observe_handoff)
            job = manager.start(
                JobType.SONG_PROCESSING,
                lambda _context: executed.append(True),
                admit=lambda _cancel: None,
                on_finally=finalize,
            )
            assert handed_off.wait(2)
            manager.cancel(job.job_id)
        finally:
            release.set()
        assert finished.wait(2)
        assert manager.get(job.job_id).state is JobState.CANCELLED
        assert finalized == [True] and not executed
