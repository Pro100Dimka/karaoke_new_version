import threading
import pytest

from backend.processing.domain import JobState, JobType
from tests.conftest import app_client
from tests.helpers import wait_for_job


def test_progress_cannot_overwrite_cancellation(tmp_path, monkeypatch):
    entered, release_save, finish_work, cancelled = (threading.Event() for _ in range(4))
    progressed = threading.Event()
    with app_client(tmp_path) as client:
        manager = client.app.state.container.system.jobs
        save = manager._save

        def blocked_save(job):
            if job.stage == "Probe" and job.state is JobState.RUNNING:
                entered.set()
                assert release_save.wait(3)
            save(job)

        def work(context):
            context.progress("Probe", 0.5, 0.5)
            progressed.set()
            assert finish_work.wait(3)

        def cancel(job_id):
            manager.cancel(job_id)
            cancelled.set()

        monkeypatch.setattr(manager, "_save", blocked_save)
        job = manager.start(JobType.SONG_PROCESSING, work)
        cancelling = threading.Thread(target=cancel, args=(job.job_id,))
        try:
            assert entered.wait(2)
            cancelling.start()
            cancelled.wait(0.2)
            release_save.set()
            cancelling.join(2)
            assert cancelled.is_set()
            assert progressed.wait(2)
            assert manager.get(job.job_id).state is JobState.CANCELLING
        finally:
            release_save.set()
            finish_work.set()
            if cancelling.ident is not None:
                cancelling.join(2)
        assert wait_for_job(client, job.job_id)["state"] == "Cancelled"


def test_terminal_job_rejects_late_progress_updates(tmp_path):
    with app_client(tmp_path) as client:
        manager = client.app.state.container.system.jobs
        job = manager.start(JobType.SONG_PROCESSING, lambda context: None)
        assert wait_for_job(client, job.job_id)["state"] == "Succeeded"
        completed = manager.get(job.job_id)
        manager._progress(job.job_id, "Late stage", 0.1, 0.1)
        assert manager.get(job.job_id) == completed


def test_job_events_are_ordered_even_when_work_completes_during_submit(tmp_path, monkeypatch):
    with app_client(tmp_path) as client:
        manager = client.app.state.container.system.jobs
        states = []
        monkeypatch.setattr(
            manager._events, "publish", lambda name, payload: states.append(payload["state"])
        )
        monkeypatch.setattr(
            manager._executor, "submit", lambda identity, work: work(threading.Event())
        )
        manager.start(JobType.SONG_PROCESSING, lambda context: None)
        assert states == ["Queued", "Running", "Succeeded"]


@pytest.mark.parametrize("outcome", [JobState.SUCCEEDED, JobState.CANCELLED, JobState.FAILED])
def test_progress_burst_keeps_live_state_without_flushing_every_update(
    tmp_path, monkeypatch, outcome
):
    from backend.processing import job_manager

    now = [100.0]
    monkeypatch.setattr(job_manager, "monotonic", lambda: now[0], raising=False)
    with app_client(tmp_path) as client:
        manager = client.app.state.container.system.jobs
        saved = []
        save = manager._save

        def track_save(job):
            if (
                job.job_type is JobType.SONG_PROCESSING
                and job.stage
                and job.state is JobState.RUNNING
            ):
                saved.append(job)
            save(job)

        monkeypatch.setattr(manager, "_save", track_save)
        monkeypatch.setattr(
            manager._executor, "submit", lambda identity, work: work(threading.Event())
        )

        def work(context):
            for index in range(100):
                context.progress(f"Stage-{index}", 0.5, index / 100)
            current = manager.get(context.job_id)
            assert current.stage == "Stage-99"
            assert current.overall_progress == 0.99
            listed = manager.list(limit=100, offset=0)
            assert next(job for job in listed if job.job_id == context.job_id) == current
            assert len(saved) == 1
            now[0] += 1.0
            context.progress("Final", 1.0, 0.8)
            assert len(saved) == 2
            assert manager.get(context.job_id).overall_progress == 0.99
            context.progress("Latest", 0.5, 0.995)
            if outcome is JobState.CANCELLED:
                manager.cancel(context.job_id)
            if outcome is JobState.FAILED:
                raise RuntimeError("failure after buffered progress")

        job = manager.start(JobType.SONG_PROCESSING, work)
        completed = manager.get(job.job_id)
        assert completed.state is outcome
        assert completed.stage == "Latest"
        with manager._uow.create() as transaction:
            assert transaction.jobs.get(job.job_id) == completed
        assert job.job_id not in manager._pending_progress
        assert job.job_id not in manager._progress_saved_at
