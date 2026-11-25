from __future__ import annotations

from dataclasses import replace
from threading import Event

from sqlalchemy import event

from backend.processing import job_manager
from backend.processing.domain import JobState, JobType


def test_progress_burst_does_not_query_sqlite_for_every_tick(client, monkeypatch) -> None:
    app = client.app.state.container
    manager = app.system.jobs
    now = [100.0]
    monkeypatch.setattr(job_manager, "monotonic", lambda: now[0])
    monkeypatch.setattr(manager._executor, "submit", lambda identity, work: work(Event()))
    reads: list[str] = []
    observed = []

    def count_reads(_connection, _cursor, statement, _parameters, _context, _many):
        if "FROM jobs" in statement:
            reads.append(statement)

    def work(context):
        before = len(reads)
        for index in range(1000):
            context.progress("Download", index / 1000, index / 1000)
        burst_reads = len(reads) - before
        observed.append((burst_reads, manager.get(context.job_id)))
        now[0] += 1
        before = len(reads)
        context.progress("Verify", 0.0, 0.999)
        observed.append((len(reads) - before, manager.get(context.job_id)))

    event.listen(app.database.engine, "before_cursor_execute", count_reads)
    try:
        job = manager.start(JobType.MODEL_DOWNLOAD, work)
    finally:
        event.remove(app.database.engine, "before_cursor_execute", count_reads)
    assert manager.get(job.job_id).state is JobState.SUCCEEDED
    assert len(observed) == 2
    assert observed[0][0] <= 3, f"A progress burst executed {observed[0][0]} SQLite reads"
    assert observed[0][1].overall_progress == 0.999
    assert observed[1][0] <= 3
    assert observed[1][1].stage == "Verify"
    assert not manager._pending_progress and not manager._progress_saved_at


def test_recovery_invalidates_unflushed_progress(client, monkeypatch) -> None:
    manager = client.app.state.container.system.jobs
    monkeypatch.setattr(job_manager, "monotonic", lambda: 100.0)
    monkeypatch.setattr(manager._executor, "submit", lambda identity, work: work(Event()))
    after_recovery = []

    def work(context):
        context.progress("Download", 0.1, 0.1)
        context.progress("Download", 0.2, 0.2)
        assert manager.recover_interrupted() == 1
        context.progress("Late update", 0.5, 0.5)
        after_recovery.append(manager.get(context.job_id))

    job = manager.start(JobType.MODEL_DOWNLOAD, work)
    assert len(after_recovery) == 1
    assert after_recovery[0].state is JobState.INTERRUPTED
    assert after_recovery[0].stage == "Download"
    assert manager.get(job.job_id).state is JobState.INTERRUPTED


def test_flush_observes_persisted_state_changes_instead_of_overwriting_them(
    client, monkeypatch
) -> None:
    manager = client.app.state.container.system.jobs
    now = [100.0]
    monkeypatch.setattr(job_manager, "monotonic", lambda: now[0])
    monkeypatch.setattr(manager._executor, "submit", lambda identity, work: work(Event()))
    observed = []

    def work(context):
        context.progress("Download", 0.1, 0.1)
        context.progress("Download", 0.2, 0.2)
        with manager._uow.create() as transaction:
            job = transaction.jobs.get(context.job_id)
            transaction.jobs.update(replace(job, state=JobState.INTERRUPTED))
            transaction.commit()
        observed.append(manager.get(context.job_id))
        now[0] += 1
        context.progress("Stale update", 0.5, 0.5)

    job = manager.start(JobType.MODEL_DOWNLOAD, work)
    assert observed[0].state is JobState.INTERRUPTED
    completed = manager.get(job.job_id)
    assert completed.state is JobState.INTERRUPTED
    assert completed.stage == "Download"
