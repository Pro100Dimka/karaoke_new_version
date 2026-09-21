from __future__ import annotations

from backend.processing.domain import Job, JobType
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.recovery.reconcile_library import ReconcileLibrary


class StartLibraryReconciliation:
    def __init__(self, jobs: ProcessingJobManager, reconcile: ReconcileLibrary) -> None:
        self._jobs = jobs
        self._reconcile = reconcile

    def execute(self) -> Job:
        return self._jobs.start(JobType.LIBRARY_RECONCILIATION, self._run)

    def _run(self, context: JobContext) -> dict[str, object]:
        context.progress("Reconcile", 0.0, 0.1)
        issues = self._reconcile.execute()
        context.progress("Reconcile", 1.0, 1.0)
        return {
            "issues": [
                {
                    "code": issue.code,
                    "entityId": issue.entity_id,
                    "action": issue.action.value,
                    "details": dict(issue.details),
                }
                for issue in issues
            ]
        }
