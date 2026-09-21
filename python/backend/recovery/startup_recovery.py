from __future__ import annotations

from dataclasses import dataclass

from backend.processing.job_manager import ProcessingJobManager
from backend.recordings.reconcile import ReconcileRecordings
from backend.recovery.reconcile_songs import ReconcileInterruptedSongs
from backend.recovery.ports import RecoveryJournal
from backend.recovery.recover_transactions import RecoverTransactions


@dataclass(frozen=True, slots=True)
class RecoverySummary:
    interrupted_jobs: int
    failed_songs: int
    recovered_recordings: tuple[str, ...]
    recovered_transactions: int
    pending_transactions: int


class StartupRecovery:
    def __init__(
        self,
        jobs: ProcessingJobManager,
        recordings: ReconcileRecordings,
        journal: RecoveryJournal,
        transactions: RecoverTransactions,
        songs: ReconcileInterruptedSongs,
    ) -> None:
        self._jobs = jobs
        self._recordings = recordings
        self._journal = journal
        self._transactions = transactions
        self._songs = songs

    def execute(self) -> RecoverySummary:
        interrupted = self._jobs.recover_interrupted()
        failed_songs = self._songs.execute()
        transactions = self._transactions.execute()
        recovered = self._recordings.execute()
        pending = len(self._journal.entries())
        return RecoverySummary(interrupted, failed_songs, recovered, transactions, pending)
