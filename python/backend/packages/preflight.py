from __future__ import annotations

from backend.domain_errors import NotFoundError
from backend.packages.inspect_package import InspectPackage, PackageInspection
from backend.persistence import UnitOfWorkFactory
from backend.projects.domain import ProjectRevision
from backend.projects.ports import ProjectStorage
from backend.storage.ports import StorageSystem
from pathlib import Path


class PackageImportPreflight:
    def __init__(
        self,
        inspect: InspectPackage,
        storage: StorageSystem,
        target_root: Path,
        safety_margin_bytes: int,
    ) -> None:
        self._inspect = inspect
        self._storage = storage
        self._target_root = target_root
        self._margin = safety_margin_bytes

    def execute(self, archive: Path) -> PackageInspection:
        inspection = self._inspect.execute(archive)
        self._storage.require_free(
            self._target_root,
            self._margin + inspection.uncompressed_bytes,
        )
        return inspection


class PackageExportPreflight:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        projects: ProjectStorage,
        storage: StorageSystem,
        target_root: Path,
        safety_margin_bytes: int,
    ) -> None:
        self._uow = uow
        self._projects = projects
        self._storage = storage
        self._target_root = target_root
        self._margin = safety_margin_bytes

    def execute(self, song_id: str, revision: int | None) -> int:
        target = self._revision(song_id, revision)
        portable_bytes = self._projects.portable_revision_size(song_id, target.revision)
        self._storage.require_free(
            self._target_root,
            self._margin + portable_bytes * 2,
        )
        return portable_bytes

    def _revision(self, song_id: str, revision: int | None) -> ProjectRevision:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            if song is None:
                raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
            target = revision if revision is not None else song.active_revision
            revision_meta = transaction.projects.get(song_id, target)
        if revision_meta is None:
            raise NotFoundError(
                "ProjectInvalid", "Project revision does not exist", revision=target
            )
        return revision_meta
