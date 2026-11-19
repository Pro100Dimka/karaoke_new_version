from __future__ import annotations

from backend.domain_errors import DependencyError, NotFoundError
from backend.packages.inspect_package import InspectPackage, PackageInspection
from backend.persistence import UnitOfWorkFactory
from backend.projects.domain import ArtifactCategory, ProjectRevision
from backend.projects.ports import ProjectStorage
from backend.songs.domain import Song
from backend.songs.prepare_clip import LOCAL_CLIP
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
        song, target = self._revision(song_id, revision)
        portable_bytes = self._portable_bytes(song, target.revision)
        self._storage.require_free(
            self._target_root,
            self._margin + portable_bytes * 2,
        )
        return portable_bytes

    def _portable_bytes(self, song: Song, revision: int) -> int:
        size = self._projects.portable_revision_size(song.song_id, revision)
        clip = self._projects.video_path(
            song.song_id, revision, prefer_local="video" in song.user_overrides
        )
        if song.video_url != LOCAL_CLIP or not clip.is_file():
            return size
        manifest = self._projects.load_manifest(song.song_id, revision)
        try:
            for artifact in manifest.artifacts:
                if (
                    artifact.category is ArtifactCategory.PORTABLE
                    and artifact.relative_path == Path("media/clip.mp4")
                ):
                    archived = self._projects.artifact_path(
                        song.song_id, revision, artifact.logical_name
                    )
                    if archived.is_file():
                        size -= archived.stat().st_size
            return size + clip.stat().st_size
        except OSError as exc:
            raise DependencyError("StorageUnavailable", "Clip size cannot be read") from exc

    def _revision(self, song_id: str, revision: int | None) -> tuple[Song, ProjectRevision]:
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
        return song, revision_meta
