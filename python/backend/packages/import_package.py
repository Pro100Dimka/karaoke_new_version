from __future__ import annotations

from dataclasses import replace
from datetime import datetime
from pathlib import Path

from backend.domain_errors import ConflictError, DomainError
from backend.history.domain import HistoryEvent
from backend.packages.domain import (
    PackageCompatibility,
    PackageConflict,
    PackageImportDecision,
)
from backend.packages.inspect_package import InspectPackage, PackageInspection
from backend.packages.project_publication import (
    PackageProjectPublication,
    PublishedPackageProject,
)
from backend.persistence import UnitOfWorkFactory
from backend.projects.domain import ProjectRevision
from backend.projects.operations import SongOperation, SongOperationRegistry
from backend.runtime import Clock, IdGenerator
from backend.songs.domain import CoverState, Song, SongStatus, SourceState


class ImportPackage:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        inspect: InspectPackage,
        publication: PackageProjectPublication,
        operations: SongOperationRegistry,
        clock: Clock,
        ids: IdGenerator,
    ) -> None:
        self._uow = uow
        self._inspect = inspect
        self._publication = publication
        self._operations = operations
        self._clock = clock
        self._ids = ids

    def execute(
        self,
        archive_path: Path,
        *,
        decision: PackageImportDecision = PackageImportDecision.SAFE_ONLY,
    ) -> Song:
        inspection = self._inspect.execute(archive_path)
        self._require_importable(inspection, decision)
        if self._is_same_revision(inspection):
            song_id = inspection.existing_song_id or ""
            published = None
            if not self._publication.revision_exists(song_id, inspection.manifest.revision):
                published = self._publication.execute(archive_path, inspection, song_id)
            try:
                song = self._activate_existing(song_id, inspection)
            except Exception:
                if published is not None:
                    self._publication.rollback(published)
                raise
            if published is not None:
                self._publication.complete(published)
            return song

        song_id = inspection.existing_song_id or inspection.manifest.song.song_id
        with self._operations.acquire(song_id, SongOperation.PACKAGE_IMPORT):
            published = self._publication.execute(archive_path, inspection, song_id)
            try:
                song = self._commit(inspection, song_id, published)
            except Exception:
                self._publication.rollback(published)
                raise
            self._publication.complete(published)
            return song

    @staticmethod
    def _is_same_revision(inspection: PackageInspection) -> bool:
        return (
            inspection.conflict is PackageConflict.SAME_REVISION
            and inspection.existing_song_id is not None
        )

    def _commit(
        self,
        inspection: PackageInspection,
        song_id: str,
        published: PublishedPackageProject,
    ) -> Song:
        manifest = inspection.manifest
        now = self._clock.now()
        with self._uow.create() as transaction:
            existing = transaction.songs.get(song_id)
            song = self._updated_song(
                existing, inspection, song_id, now, published.project_format_version
            )
            if existing:
                transaction.songs.update(song)
            else:
                transaction.songs.add(song)
            transaction.projects.add(
                ProjectRevision(
                    song_id,
                    manifest.revision,
                    published.fingerprint,
                    published.project_format_version,
                    manifest.lineage_id,
                    now,
                )
            )
            transaction.history.add(
                HistoryEvent(
                    self._ids.new(),
                    "PackageImported",
                    now,
                    "Song",
                    song_id,
                )
            )
            transaction.commit()
        return song

    @staticmethod
    def _updated_song(
        existing: Song | None,
        inspection: PackageInspection,
        song_id: str,
        now: datetime,
        project_format_version: int,
    ) -> Song:
        manifest = inspection.manifest
        if existing:
            return replace(
                existing,
                active_revision=manifest.revision,
                project_format_version=project_format_version,
                status=SongStatus.READY,
                updated_at=now,
            )
        identity = manifest.song
        return Song(
            song_id=song_id,
            title=identity.title,
            artist=identity.artist,
            source_identity=identity.source_identity,
            source_state=SourceState.PACKAGE_ONLY,
            source_path=None,
            status=SongStatus.READY,
            active_revision=manifest.revision,
            project_format_version=project_format_version,
            created_at=now,
            updated_at=now,
            duration=identity.duration,
            language=identity.language,
            album=identity.album,
            genre=identity.genre,
            artwork_url=identity.artwork_url,
            video_url=identity.video_url,
            recognition_provider=identity.recognition_provider,
            recognition_external_id=identity.recognition_external_id,
            cover_state=CoverState.FALLBACK,
        )

    @staticmethod
    def _require_importable(
        inspection: PackageInspection,
        decision: PackageImportDecision,
    ) -> None:
        if inspection.compatibility not in {
            PackageCompatibility.CURRENT,
            PackageCompatibility.UPGRADEABLE,
        }:
            raise DomainError(
                "PackageVersionUnsupported",
                "Package requires migration or is unsupported",
                409,
                {"compatibility": inspection.compatibility.value},
            )
        allowed = {
            PackageImportDecision.ACCEPT_OLDER: PackageConflict.OLDER_REVISION,
            PackageImportDecision.ACCEPT_DIVERGENT: PackageConflict.DIVERGENT_REVISION,
        }
        conflicts = {
            PackageConflict.OLDER_REVISION,
            PackageConflict.DIVERGENT_REVISION,
        }
        if inspection.conflict in conflicts and allowed.get(decision) is not inspection.conflict:
            raise ConflictError(
                "PackageConflict",
                "Package conflicts with local project",
                conflict=inspection.conflict.value,
            )

    def _activate_existing(self, song_id: str, inspection: PackageInspection) -> Song:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            activated = self._updated_song(
                song,
                inspection,
                song_id,
                self._clock.now(),
                inspection.manifest.project_format_version,
            )
            if song is None:
                transaction.songs.add(activated)
            else:
                transaction.songs.update(activated)
            transaction.commit()
            return activated
