from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Callable

from backend.history.domain import HistoryEvent
from backend.packages.codec import encode_manifest
from backend.packages.domain import PackageArtifact, PackageManifest, PackageSongIdentity
from backend.packages.ports import PackageArchive, PackageOutputStorage
from backend.packages.snapshot_package import SnapshotPackage, custom_cover_path
from backend.persistence import UnitOfWorkFactory
from backend.projects.domain import ArtifactCategory, ProjectManifest, ProjectRevision
from backend.projects.operations import SongOperation, SongOperationRegistry
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
        snapshot: SnapshotPackage,
        archive: PackageArchive,
        outputs: PackageOutputStorage,
        workspaces: WorkStorage,
        operations: SongOperationRegistry,
        hasher: FileHasher,
        clock: Clock,
        ids: IdGenerator,
    ) -> None:
        self._uow = uow
        self._snapshot = snapshot
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
            workspace = self._workspaces.allocate(f"export-{song_id}")
            try:
                song, revision_meta, project, snapshot = self._snapshot.execute(
                    song_id, revision, workspace
                )
                ensure_not_cancelled()
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

    def _package(
        self,
        song: Song,
        revision: ProjectRevision,
        project: ProjectManifest,
        snapshot: Path,
    ) -> tuple[PackageManifest, dict[PurePosixPath, Path]]:
        files, artifacts = self._project_files(project, snapshot)
        local_clip = snapshot / "media/clip.mp4"
        if song.video_url == LOCAL_CLIP and local_clip.is_file():
            relative = PurePosixPath("media/clip.mp4")
            files[relative] = local_clip
            artifacts.append(PackageArtifact(relative, self._hasher(local_clip)))
        cover = custom_cover_path(song)
        if cover is not None:
            files[cover] = snapshot.joinpath(*cover.parts)
            artifacts.append(PackageArtifact(cover, self._hasher(files[cover])))
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

    def _project_files(
        self, project: ProjectManifest, snapshot: Path
    ) -> tuple[dict[PurePosixPath, Path], list[PackageArtifact]]:
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
        return files, artifacts

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
        custom_cover=custom_cover_path(song),
    )
