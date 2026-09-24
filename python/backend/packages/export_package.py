from __future__ import annotations

from pathlib import Path, PurePosixPath

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
from backend.songs.prepare_clip import LOCAL_CLIP, clip_path
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

    def execute(self, song_id: str, revision: int | None = None) -> Path:
        with self._operations.acquire(song_id, SongOperation.PACKAGE_EXPORT):
            song, revision_meta = self._load(song_id, revision)
            workspace = self._workspaces.allocate(f"export-{song_id}")
            try:
                snapshot = self._projects.snapshot_revision(
                    song_id, revision_meta.revision, workspace
                )
                project = self._projects.load_manifest(song_id, revision_meta.revision)
                package, files = self._package(song, revision_meta, project, snapshot)
                output = self._outputs.path_for_export(song_id, revision_meta.revision)
                self._archive.build(
                    output, files, {PurePosixPath("package.json"): encode_manifest(package)}
                )
                self._record(song_id)
                return output
            finally:
                self._workspaces.cleanup(workspace)

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
        files: dict[PurePosixPath, Path] = {
            PurePosixPath("manifest.json"): snapshot / "manifest.json"
        }
        artifacts: list[PackageArtifact] = [
            PackageArtifact(
                PurePosixPath("manifest.json"), self._hasher.hash_file(snapshot / "manifest.json")
            )
        ]
        for artifact in project.artifacts:
            if artifact.category is not ArtifactCategory.PORTABLE:
                continue
            relative = PurePosixPath(artifact.relative_path.as_posix())
            source = snapshot / artifact.relative_path
            files[relative] = source
            artifacts.append(PackageArtifact(relative, self._hasher.hash_file(source)))
        local_clip = clip_path(song)
        if song.video_url == LOCAL_CLIP and local_clip is not None and local_clip.is_file():
            relative = PurePosixPath("media/clip.mp4")
            files[relative] = local_clip
            artifacts.append(PackageArtifact(relative, self._hasher.hash_file(local_clip)))
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
