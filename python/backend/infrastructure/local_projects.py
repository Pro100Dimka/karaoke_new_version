from __future__ import annotations

import hashlib
import logging
import os
import shutil
from collections.abc import Callable, Mapping
from functools import partial
from pathlib import Path

from backend.domain_errors import ConflictError, DependencyError, NotFoundError
from backend.infrastructure.atomic_files import atomic_write_text, replace_with_retry
from backend.projects.domain import ArtifactCategory, ProjectArtifact, ProjectManifest
from backend.projects.manifest_codec import decode_manifest, encode_manifest
from backend.storage.domain import StorageRoots
from backend.version import PROJECT_FORMAT_VERSION

logger = logging.getLogger(__name__)


class LocalProjectStorage:
    def __init__(self, roots: StorageRoots) -> None:
        self._roots = roots

    def create_imported(self, song_id: str, revision: int, source: Path) -> ProjectManifest:
        working = self.begin_revision(song_id, revision)
        manifest = ProjectManifest(
            project_format_version=PROJECT_FORMAT_VERSION,
            song_id=song_id,
            revision=revision,
            artifacts=(
                ProjectArtifact(
                    logical_name="source",
                    relative_path=Path("source.ref"),
                    category=ArtifactCategory.LOCAL_ONLY,
                    checksum=hashlib.sha256(str(source).encode("utf-8")).hexdigest(),
                ),
            ),
            provenance={"kind": "imported", "sourcePath": str(source)},
        )
        atomic_write_text(working / "source.ref", str(source))
        atomic_write_text(working / "manifest.json", encode_manifest(manifest))
        self.publish_revision(song_id, revision, working)
        return manifest

    def load_manifest(self, song_id: str, revision: int) -> ProjectManifest:
        path = self._revision_root(song_id, revision) / "manifest.json"
        if not path.is_file():
            raise NotFoundError("ProjectInvalid", "Project manifest is missing", songId=song_id)
        try:
            return decode_manifest(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DependencyError(
                "ProjectInvalid", "Project manifest is invalid", songId=song_id
            ) from exc

    def video_path(self, song_id: str, revision: int, *, prefer_local: bool = False) -> Path:
        local = self._roots.songs / song_id / "media" / "clip.mp4"
        archived = self._revision_root(song_id, revision) / "media" / "clip.mp4"
        return local if prefer_local or not archived.is_file() else archived

    def read_text_artifact(self, song_id: str, revision: int, logical_name: str) -> str:
        path = self.artifact_path(song_id, revision, logical_name)
        try:
            return path.read_text(encoding="utf-8")
        except OSError as exc:
            raise DependencyError("ProjectInvalid", "Project artifact cannot be read") from exc

    def artifact_path(self, song_id: str, revision: int, logical_name: str) -> Path:
        manifest = self.load_manifest(song_id, revision)
        artifact = next(
            (item for item in manifest.artifacts if item.logical_name == logical_name), None
        )
        if artifact is None:
            raise NotFoundError(
                "ArtifactNotFound", "Project artifact was not found", artifact=logical_name
            )
        return self._revision_root(song_id, revision) / artifact.relative_path

    def begin_revision(self, song_id: str, revision: int) -> Path:
        working = self._roots.temp / f"project-{song_id}-{revision}"
        shutil.rmtree(working, ignore_errors=True)
        working.mkdir(parents=True)
        return working

    def stage_revision(
        self,
        song_id: str,
        revision: int,
        files: Mapping[Path, Path],
        texts: Mapping[Path, str],
        *,
        base_revision: int | None = None,
    ) -> Path:
        working = (
            self.begin_revision(song_id, revision)
            if base_revision is None
            else self.clone_revision(song_id, base_revision, revision)
        )
        for relative, source in files.items():
            target = working / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_file() and target.samefile(source):
                # A cloned revision already shares this unchanged immutable artifact.
                continue
            target.unlink(missing_ok=True)
            shutil.copyfile(source, target)
        for relative, text in texts.items():
            atomic_write_text(working / relative, text)
        return working

    def working_path(self, working: Path, relative_path: Path) -> Path:
        return working / relative_path

    def read_working_text(self, working: Path, relative_path: Path) -> str:
        return (working / relative_path).read_text(encoding="utf-8")

    def write_working_text(self, working: Path, relative_path: Path, text: str) -> None:
        atomic_write_text(working / relative_path, text)

    def clone_revision(self, song_id: str, source_revision: int, target_revision: int) -> Path:
        source = self._revision_root(song_id, source_revision)
        if not source.is_dir():
            raise NotFoundError("ProjectInvalid", "Source revision does not exist")
        working = self.begin_revision(song_id, target_revision)
        shutil.rmtree(working)
        # Editor saves replace changed lyrics, manifests and melody guides; the new revision
        # shares all unchanged assets instead of copying hundreds of megabytes.
        # Sharing is safe: every write into a revision replaces the file instead of editing it.
        shutil.copytree(source, working, copy_function=_link_or_copy)
        return working

    def publish_revision(self, song_id: str, revision: int, working: Path) -> None:
        target = self._revision_root(song_id, revision)
        if target.exists():
            raise ConflictError(
                "RevisionConflict", "Project revision already exists", revision=revision
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            replace_with_retry(working, target)
        except OSError as exc:
            raise DependencyError(
                "StorageUnavailable",
                "Project revision publication failed",
                errno=exc.errno,
                winerror=getattr(exc, "winerror", None),
            ) from exc

    def snapshot_revision(
        self,
        song_id: str,
        revision: int,
        destination: Path,
        *,
        supplemental_files: Mapping[Path, Path] | None = None,
        portable_only: bool = False,
        ensure_not_cancelled: Callable[[], None] | None = None,
    ) -> Path:
        if ensure_not_cancelled:
            ensure_not_cancelled()
        source = self._revision_root(song_id, revision)
        if not source.is_dir():
            raise NotFoundError("ProjectInvalid", "Project revision does not exist")
        target = destination / f"revision-{revision}"
        files: dict[Path, Path] = {}
        if portable_only:
            manifest = self.load_manifest(song_id, revision)
            files = {Path("manifest.json"): source / "manifest.json"}
            files.update(
                (artifact.relative_path, source / artifact.relative_path)
                for artifact in manifest.artifacts
                if artifact.category is ArtifactCategory.PORTABLE
            )
            target.mkdir(parents=True)
        else:
            _copy_snapshot_tree(source, target, ensure_not_cancelled)
        files.update(supplemental_files or {})
        for relative, source_file in files.items():
            snapshot_file = target / relative
            snapshot_file.parent.mkdir(parents=True, exist_ok=True)
            _copy_snapshot_file(source_file, snapshot_file, ensure_not_cancelled)
        return target

    def revision_exists(self, song_id: str, revision: int) -> bool:
        return self._revision_root(song_id, revision).is_dir()

    def remove_revision(self, song_id: str, revision: int) -> None:
        shutil.rmtree(self._revision_root(song_id, revision), ignore_errors=True)

    def install_revision_artifact(
        self, song_id: str, revision: int, relative_path: Path, source: Path,
        *,
        publish: Callable[[Path, Path], None] | None = None,
        ensure_not_cancelled: Callable[[], None] | None = None,
    ) -> None:
        target = self._revision_root(song_id, revision) / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.importing")
        try:
            _copy_snapshot_file(source, temporary, ensure_not_cancelled)
            (publish or os.replace)(temporary, target)
        except OSError as exc:
            raise DependencyError("StorageUnavailable", "Project artifact import failed") from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                logger.warning(
                    "Could not remove temporary project artifact: %s", temporary, exc_info=True
                )

    def portable_revision_size(self, song_id: str, revision: int) -> int:
        root = self._revision_root(song_id, revision)
        manifest = self.load_manifest(song_id, revision)
        paths = [root / "manifest.json"]
        paths.extend(
            root / artifact.relative_path
            for artifact in manifest.artifacts
            if artifact.category is ArtifactCategory.PORTABLE
        )
        try:
            return sum(path.stat().st_size for path in paths if path.is_file())
        except OSError as exc:
            raise DependencyError("StorageUnavailable", "Project size cannot be read") from exc

    def song_ids(self) -> tuple[str, ...]:
        if not self._roots.songs.exists():
            return ()
        return tuple(sorted(path.name for path in self._roots.songs.iterdir() if path.is_dir()))

    def revisions(self, song_id: str) -> tuple[int, ...]:
        root = self._roots.songs / song_id / "revisions"
        if not root.exists():
            return ()
        values = [
            int(path.name) for path in root.iterdir() if path.is_dir() and path.name.isdigit()
        ]
        return tuple(sorted(values))

    def _revision_root(self, song_id: str, revision: int) -> Path:
        return self._roots.songs / song_id / "revisions" / str(revision)


def _link_or_copy(source: str, target: str) -> None:
    try:
        os.link(source, target)
    except OSError:
        # A file system without hard links (FAT/exFAT) still gets a full copy.
        shutil.copy2(source, target)


def _copy_snapshot_file(
    source: Path, target: Path, ensure_not_cancelled: Callable[[], None] | None
) -> None:
    if ensure_not_cancelled is None:
        shutil.copyfile(source, target)
        return
    ensure_not_cancelled()
    with source.open("rb") as original, target.open("wb") as snapshot:
        buffer = bytearray(1024 * 1024)
        view = memoryview(buffer)
        while True:
            ensure_not_cancelled()
            count = original.readinto(buffer)
            if not count:
                break
            snapshot.write(view[:count])
    ensure_not_cancelled()


def _copy_snapshot_tree(
    source: Path, target: Path, ensure_not_cancelled: Callable[[], None] | None
) -> None:
    copy = (
        shutil.copy2
        if ensure_not_cancelled is None
        else partial(_copy_snapshot_metadata, ensure_not_cancelled=ensure_not_cancelled)
    )
    shutil.copytree(source, target, copy_function=copy)


def _copy_snapshot_metadata(
    source: str, target: str, *, ensure_not_cancelled: Callable[[], None]
) -> str:
    _copy_snapshot_file(Path(source), Path(target), ensure_not_cancelled)
    shutil.copystat(source, target)
    return target
