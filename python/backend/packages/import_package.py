from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Callable

from backend.domain_errors import ConflictError, DomainError
from backend.history.domain import HistoryEvent
from backend.packages.domain import (
    PackageCompatibility,
    PackageConflict,
    PackageImportDecision,
    PackageSongIdentity,
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
from backend.songs.ports import SongMediaUpdate, SongStorage


@dataclass(frozen=True, slots=True)
class PackageImportResult:
    song: Song
    created: bool


class ImportPackage:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        inspect: InspectPackage,
        publication: PackageProjectPublication,
        songs: SongStorage,
        operations: SongOperationRegistry,
        clock: Clock,
        ids: IdGenerator,
    ) -> None:
        self._uow = uow
        self._inspect = inspect
        self._publication = publication
        self._songs = songs
        self._operations = operations
        self._clock = clock
        self._ids = ids

    def execute(
        self,
        archive_path: Path,
        *,
        decision: PackageImportDecision = PackageImportDecision.SAFE_ONLY,
        ensure_not_cancelled: Callable[[], None] | None = None,
    ) -> PackageImportResult:
        inspection = self._inspect.execute(archive_path)
        self._require_importable(inspection, decision)
        song_id = inspection.existing_song_id or inspection.manifest.song.song_id
        operation = self._operations.acquire(song_id, SongOperation.PACKAGE_IMPORT)
        with operation, self._songs.media_update(song_id) as media:
            if ensure_not_cancelled:
                ensure_not_cancelled()
            published = None
            committed = False
            try:
                install_cover = self._cover_installer(song_id, media)
                published = self._publish_missing(
                    archive_path, inspection, song_id, install_cover, ensure_not_cancelled
                )
                cover = self._prepare_cover(
                    archive_path,
                    inspection,
                    song_id,
                    published,
                    install_cover,
                    ensure_not_cancelled,
                    media,
                )
                if ensure_not_cancelled:
                    ensure_not_cancelled()
                result = self._commit_import(inspection, song_id, published, cover)
                media.commit()
                committed = True
                return result
            finally:
                if published is not None:
                    finish = self._publication.complete if committed else self._publication.rollback
                    finish(published)

    def _publish_missing(
        self,
        archive_path: Path,
        inspection: PackageInspection,
        song_id: str,
        install_cover: Callable[[Path], Path] | None,
        ensure_not_cancelled: Callable[[], None] | None,
    ) -> PublishedPackageProject | None:
        if self._is_same_revision(inspection) and self._publication.revision_exists(
            song_id, inspection.local_revision or inspection.manifest.revision
        ):
            return None
        return self._publication.execute(
            archive_path,
            inspection,
            song_id,
            install_cover=install_cover,
            ensure_not_cancelled=ensure_not_cancelled,
        )

    def _prepare_cover(
        self,
        archive_path: Path,
        inspection: PackageInspection,
        song_id: str,
        published: PublishedPackageProject | None,
        install_cover: Callable[[Path], Path] | None,
        ensure_not_cancelled: Callable[[], None] | None,
        media: SongMediaUpdate,
    ) -> Path | None:
        if published is not None:
            return published.custom_cover
        return self._publication.supplement_same_revision(
            archive_path,
            inspection,
            song_id,
            install_cover=install_cover,
            publish_artifact=lambda staged, target: media.publish_revision_artifact(
                staged, target, ensure_not_cancelled=ensure_not_cancelled
            ),
            ensure_not_cancelled=ensure_not_cancelled,
        )

    def _commit_import(
        self,
        inspection: PackageInspection,
        song_id: str,
        published: PublishedPackageProject | None,
        cover: Path | None,
    ) -> PackageImportResult:
        if self._is_same_revision(inspection):
            return PackageImportResult(self._activate_existing(song_id, inspection, cover), False)
        assert published is not None
        return self._commit(inspection, song_id, published)

    def _cover_installer(
        self, song_id: str, media: SongMediaUpdate
    ) -> Callable[[Path], Path] | None:
        # Manual cover edits use the same media lock. Check the current row before any copy,
        # including when the incoming file has the same name or the revision is already known.
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
        if song and (song.cover_state is CoverState.CUSTOM or "cover" in song.user_overrides):
            return None
        return media.copy_cover

    @staticmethod
    def _is_same_revision(inspection: PackageInspection) -> bool:
        return inspection.matches_existing_revision and inspection.existing_song_id is not None

    def _commit(
        self,
        inspection: PackageInspection,
        song_id: str,
        published: PublishedPackageProject,
    ) -> PackageImportResult:
        manifest = inspection.manifest
        now = self._clock.now()
        with self._uow.create() as transaction:
            existing = transaction.songs.get(song_id)
            song = self._updated_song(
                existing,
                inspection,
                song_id,
                now,
                published.project_format_version,
                published.revision,
                published.custom_cover,
            )
            if existing:
                transaction.songs.update(song)
            else:
                transaction.songs.add(song)
            transaction.projects.add(
                ProjectRevision(
                    song_id,
                    published.revision,
                    published.fingerprint,
                    published.project_format_version,
                    manifest.lineage_id,
                    now,
                )
            )
            event = HistoryEvent(self._ids.new(), "PackageImported", now, "Song", song_id)
            transaction.history.add(event)
            transaction.commit()
        return PackageImportResult(song, existing is None)

    @staticmethod
    def _updated_song(
        existing: Song | None,
        inspection: PackageInspection,
        song_id: str,
        now: datetime,
        project_format_version: int,
        revision: int,
        custom_cover: Path | None = None,
    ) -> Song:
        identity = inspection.manifest.song
        if existing is not None and existing.source_identity != identity.source_identity:
            raise ConflictError(
                "PackageConflict", "A different song already uses this project identity"
            )
        song = existing or _new_package_song(
            identity, song_id, now, project_format_version, revision
        )
        if custom_cover is not None:
            song = replace(
                song,
                cover_path=custom_cover,
                cover_state=CoverState.CUSTOM,
                user_overrides=song.user_overrides | {"cover"},
            )
        return replace(
            song,
            active_revision=revision,
            project_format_version=project_format_version,
            status=SongStatus.READY,
            video_url=identity.video_url,
            user_overrides=song.user_overrides - {"video"},
            updated_at=now,
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

    def _activate_existing(
        self, song_id: str, inspection: PackageInspection, custom_cover: Path | None
    ) -> Song:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            activated = self._updated_song(
                song,
                inspection,
                song_id,
                self._clock.now(),
                inspection.manifest.project_format_version,
                inspection.local_revision or inspection.manifest.revision,
                custom_cover,
            )
            if song is None:
                transaction.songs.add(activated)
            else:
                transaction.songs.update(activated)
            transaction.commit()
            return activated


def _new_package_song(
    identity: PackageSongIdentity,
    song_id: str,
    now: datetime,
    project_format_version: int,
    revision: int,
) -> Song:
    return Song(
        song_id=song_id,
        title=identity.title,
        artist=identity.artist,
        source_identity=identity.source_identity,
        source_state=SourceState.PACKAGE_ONLY,
        source_path=None,
        status=SongStatus.READY,
        active_revision=revision,
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
