from __future__ import annotations

import hashlib
from pathlib import Path

from backend.domain_errors import ConflictError, DomainError
from backend.idempotency import IdempotencyRecord
from backend.packages.export_package import ExportPackage
from backend.packages.import_package import ImportPackage
from backend.packages.preflight import PackageExportPreflight, PackageImportPreflight
from backend.packages.domain import PackageImportDecision
from backend.persistence import UnitOfWorkFactory
from backend.processing.domain import Job, JobType
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.runtime import Clock
from backend.songs.ports import FileHasher


class StartPackageExport:
    def __init__(
        self,
        jobs: ProcessingJobManager,
        export: ExportPackage,
        preflight: PackageExportPreflight,
    ) -> None:
        self._jobs = jobs
        self._export = export
        self._preflight = preflight

    def execute(self, song_id: str, revision: int | None) -> Job:
        self._preflight.execute(song_id, revision)
        return self._jobs.start(
            JobType.PACKAGE_EXPORT,
            lambda context: self._run(song_id, revision, context),
            entity_id=song_id,
        )

    def _run(self, song_id: str, revision: int | None, context: JobContext) -> dict[str, object]:
        context.progress("Snapshot", 0.0, 0.1)
        path = self._export.execute(song_id, revision)
        context.progress("Archive", 1.0, 1.0)
        return {"songId": song_id, "path": str(path)}


class StartPackageImport:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        jobs: ProcessingJobManager,
        import_package: ImportPackage,
        hasher: FileHasher,
        clock: Clock,
        preflight: PackageImportPreflight,
    ) -> None:
        self._uow = uow
        self._jobs = jobs
        self._import = import_package
        self._hasher = hasher
        self._clock = clock
        self._preflight = preflight

    def execute(
        self,
        path: Path,
        decision: PackageImportDecision,
        idempotency_key: str | None,
    ) -> Job:
        request_hash = _request_hash(self._hasher.hash_file(path), decision)
        repeated = self._repeat(idempotency_key, request_hash)
        if repeated:
            return repeated
        self._preflight.execute(path)
        job = self._jobs.start(
            JobType.PACKAGE_IMPORT,
            lambda context: self._run(path, decision, context),
        )
        self._save(idempotency_key, request_hash, job.job_id)
        return job

    def _run(
        self,
        path: Path,
        decision: PackageImportDecision,
        context: JobContext,
    ) -> dict[str, object]:
        context.progress("SecurityValidation", 0.0, 0.1)
        song = self._import.execute(path, decision=decision)
        context.progress("Publish", 1.0, 1.0)
        return {"songId": song.song_id, "revision": song.active_revision}

    def _repeat(self, key: str | None, request_hash: str) -> Job | None:
        if not key:
            return None
        with self._uow.create() as transaction:
            record = transaction.idempotency.get("ImportPackage", key)
            if record is None:
                return None
            if record.request_hash != request_hash:
                raise ConflictError(
                    "IdempotencyConflict", "Idempotency key was reused with different input"
                )
            job = transaction.jobs.get(record.response_json)
        if job is None:
            raise DomainError("IdempotencyStateInvalid", "Stored package job no longer exists", 500)
        return job

    def _save(self, key: str | None, request_hash: str, job_id: str) -> None:
        if not key:
            return
        with self._uow.create() as transaction:
            transaction.idempotency.add(
                IdempotencyRecord("ImportPackage", key, request_hash, job_id, self._clock.now())
            )
            transaction.commit()


def _request_hash(content_hash: str, decision: PackageImportDecision) -> str:
    raw = f"{content_hash}\0{decision.value}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
