import threading

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
