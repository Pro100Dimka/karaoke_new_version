from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Callable

from backend.domain_errors import NotFoundError
from backend.history.domain import HistoryEvent
from backend.packages.codec import encode_manifest
from backend.packages.domain import PackageArtifact, PackageManifest, PackageSongIdentity
from backend.packages.ports import PackageArchive, PackageOutputStorage
from backend.persistence import UnitOfWorkFactory
from backend.projects.domain import ArtifactCategory, ProjectManifest, ProjectRevision
from backend.projects.operations import SongOperation, SongOperationRegistry
from backend.projects.ports import ProjectStorage
from backend.runtime import Clock, IdGenerator
from backend.songs.domain import Song
from backend.songs.prepare_clip import LOCAL_CLIP
from backend.songs.ports import FileHasher
from backend.storage.ports import WorkStorage
from backend.version import PACKAGE_FORMAT_VERSION


class ExportPackage:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        projects: ProjectStorage,
        archive: PackageArchive,
        outputs: PackageOutputStorage,
        workspaces: WorkStorage,
        operations: SongOperationRegistry,
        hasher: FileHasher,
        clock: Clock,
        ids: IdGenerator,
    ) -> None:
        self._uow = uow
        self._projects = projects
        self._archive = archive
        self._outputs = outputs
        self._workspaces = workspaces
        self._operations = operations
        self._hasher = hasher
        self._clock = clock
        self._ids = ids

    def execute(
        self,
        song_id: str,
        revision: int | None = None,
        *,
        ensure_not_cancelled: Callable[[], None] = lambda: None,
    ) -> Path:
        ensure_not_cancelled()
        with self._operations.acquire(song_id, SongOperation.PACKAGE_EXPORT):
            song, revision_meta = self._load(song_id, revision)
            workspace = self._workspaces.allocate(f"export-{song_id}")
            try:
                snapshot = self._snapshot(song, revision_meta.revision, workspace)
                ensure_not_cancelled()
                project = self._projects.load_manifest(song_id, revision_meta.revision)
                package, files = self._package(song, revision_meta, project, snapshot)
                ensure_not_cancelled()
                output = self._outputs.path_for_export(song_id, revision_meta.revision)
                self._archive.build(
                    output,
                    files,
                    {PurePosixPath("package.json"): encode_manifest(package)},
                    progress=lambda _: ensure_not_cancelled(),
                )
                self._record(song_id)
                return output
            finally:
                self._workspaces.cleanup(workspace)

    def _snapshot(self, song: Song, revision: int, workspace: Path) -> Path:
        supplemental: dict[Path, Path] = {}
        clip = self._projects.video_path(
            song.song_id, revision, prefer_local="video" in song.user_overrides
        )
        if song.video_url == LOCAL_CLIP and clip.is_file():
            supplemental[Path("media/clip.mp4")] = clip
        return self._projects.snapshot_revision(
            song.song_id,
            revision,
            workspace,
            supplemental_files=supplemental,
            portable_only=True,
        )

    def _load(self, song_id: str, revision: int | None) -> tuple[Song, ProjectRevision]:
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

    def _package(
        self,
        song: Song,
        revision: ProjectRevision,
        project: ProjectManifest,
        snapshot: Path,
    ) -> tuple[PackageManifest, dict[PurePosixPath, Path]]:
        manifest_path = PurePosixPath("manifest.json")
        files = {manifest_path: snapshot / "manifest.json"}
        artifacts = [PackageArtifact(manifest_path, self._hasher(files[manifest_path]))]
        for artifact in project.artifacts:
            if artifact.category is not ArtifactCategory.PORTABLE:
                continue
            relative = PurePosixPath(artifact.relative_path.as_posix())
            source = snapshot / artifact.relative_path
            files[relative] = source
            artifacts.append(PackageArtifact(relative, self._hasher(source)))
        local_clip = snapshot / "media/clip.mp4"
        if song.video_url == LOCAL_CLIP and local_clip.is_file():
            relative = PurePosixPath("media/clip.mp4")
            files[relative] = local_clip
            artifacts.append(PackageArtifact(relative, self._hasher(local_clip)))
        identity = _song_identity(song)
        return (
            PackageManifest(
                PACKAGE_FORMAT_VERSION,
                project.project_format_version,
                identity,
                revision.revision,
                revision.fingerprint,
                revision.lineage_id,
                tuple(artifacts),
            ),
            files,
        )

    def _record(self, song_id: str) -> None:
        now = self._clock.now()
        with self._uow.create() as transaction:
            transaction.history.add(
                HistoryEvent(self._ids.new(), "PackageExported", now, "Song", song_id)
            )
            transaction.commit()


def _song_identity(song: Song) -> PackageSongIdentity:
    return PackageSongIdentity(
        song_id=song.song_id,
        source_identity=song.source_identity,
        title=song.title,
        artist=song.artist,
        duration=song.duration,
        language=song.language,
        album=song.album,
        genre=song.genre,
        artwork_url=song.artwork_url,
        video_url=song.video_url,
        recognition_provider=song.recognition_provider,
        recognition_external_id=song.recognition_external_id,
    )
