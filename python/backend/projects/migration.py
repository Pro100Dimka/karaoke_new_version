from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from backend.domain_errors import ConflictError, DomainError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.runtime import Clock, IdGenerator
from backend.projects.content_lock import KeyedLockManager
from backend.projects.operations import SongOperation, SongOperationRegistry
from backend.persistence import UnitOfWorkFactory
from backend.projects.domain import ProjectCompatibility, ProjectManifest, ProjectRevision
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import encode_manifest
from backend.projects.ports import ProjectStorage
from backend.songs.domain import Song
from backend.projects.validator import ProjectValidator
from backend.recovery.domain import RecoveryOperation
from backend.recovery.ports import RecoveryJournal
from backend.version import PROJECT_FORMAT_VERSION


class GetProjectCompatibility:
    def __init__(self, projects: ProjectStorage) -> None:
        self._projects = projects

    def execute(self, song_id: str, revision: int) -> ProjectCompatibility:
        try:
            manifest = self._projects.load_manifest(song_id, revision)
        except DomainError:
            return ProjectCompatibility.INVALID
        version = manifest.project_format_version
        if version == PROJECT_FORMAT_VERSION:
            return ProjectCompatibility.CURRENT
        if version == PROJECT_FORMAT_VERSION - 1:
            return ProjectCompatibility.UPGRADEABLE
        if version > PROJECT_FORMAT_VERSION:
            return ProjectCompatibility.TOO_NEW
        return ProjectCompatibility.UNSUPPORTED


class MigrateProject:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        projects: ProjectStorage,
        validator: ProjectValidator,
        operations: SongOperationRegistry,
        locks: KeyedLockManager,
        journal: RecoveryJournal,
        backup_root: Path,
        clock: Clock,
        ids: IdGenerator,
    ) -> None:
        self._uow = uow
        self._projects = projects
        self._validator = validator
        self._operations = operations
        self._locks = locks
        self._journal = journal
        self._backup_root = backup_root
        self._clock = clock
        self._ids = ids

    def execute(self, song_id: str) -> int:
        with self._operations.acquire(song_id, SongOperation.MIGRATION):
            song, revision = self._load(song_id)
            manifest = self._projects.load_manifest(song_id, song.active_revision)
            if manifest.project_format_version == PROJECT_FORMAT_VERSION:
                return song.active_revision
            self._require_upgradeable(manifest)
            self._projects.snapshot_revision(song_id, song.active_revision, self._backup_root)
            return self._migrate(song, revision.lineage_id, manifest)

    def _migrate(self, song: Song, lineage_id: str, manifest: ProjectManifest) -> int:
        new_revision = song.active_revision + 1
        upgraded = replace(
            manifest,
            project_format_version=PROJECT_FORMAT_VERSION,
            revision=new_revision,
        )
        working = self._projects.clone_revision(song.song_id, song.active_revision, new_revision)
        self._projects.write_working_text(working, Path("manifest.json"), encode_manifest(upgraded))
        self._validator.validate_working(upgraded, working, require_ready=True)
        entry = self._journal.begin(
            RecoveryOperation.PROJECT_PUBLISH,
            {"songId": song.song_id, "revision": new_revision, "working": str(working)},
        )
        self._commit(song.song_id, song.active_revision, lineage_id, upgraded, working)
        self._journal.complete(entry.transaction_id)
        return new_revision

    def _load(self, song_id: str) -> tuple[Song, ProjectRevision]:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            if song is None:
                raise NotFoundError("SongNotFound", "Song was not found")
            revision = transaction.projects.get(song_id, song.active_revision)
        if revision is None:
            raise NotFoundError("ProjectInvalid", "Project revision metadata is missing")
        return song, revision

    @staticmethod
    def _require_upgradeable(manifest: ProjectManifest) -> None:
        if manifest.project_format_version > PROJECT_FORMAT_VERSION:
            raise DomainError(
                "UnsupportedProjectVersion", "Project format is newer than this backend", 409
            )
        if manifest.project_format_version != PROJECT_FORMAT_VERSION - 1:
            raise DomainError("UnsupportedProjectVersion", "Project format is not upgradeable", 409)

    def _commit(
        self,
        song_id: str,
        expected_revision: int,
        lineage_id: str,
        manifest: ProjectManifest,
        working: Path,
    ) -> None:
        with self._locks.acquire(song_id):
            with self._uow.create() as transaction:
                song = transaction.songs.get(song_id)
                if song is None or song.active_revision != expected_revision:
                    raise ConflictError("RevisionConflict", "Project changed during migration")
                self._projects.publish_revision(song_id, manifest.revision, working)
                now = self._clock.now()
                transaction.songs.update(
                    replace(
                        song,
                        active_revision=manifest.revision,
                        project_format_version=PROJECT_FORMAT_VERSION,
                        updated_at=now,
                    )
                )
                transaction.projects.add(
                    ProjectRevision(
                        song_id,
                        manifest.revision,
                        manifest_fingerprint(manifest),
                        PROJECT_FORMAT_VERSION,
                        lineage_id,
                        now,
                    )
                )
                transaction.history.add(
                    HistoryEvent(self._ids.new(), "ProjectMigrated", now, "Song", song_id)
                )
                transaction.commit()
