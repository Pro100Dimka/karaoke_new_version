from __future__ import annotations

import hashlib
import os
import shutil
from collections.abc import Mapping
from pathlib import Path

from backend.domain_errors import ConflictError, DependencyError, NotFoundError
from backend.infrastructure.atomic_files import atomic_write_text
from backend.projects.domain import ArtifactCategory, ProjectArtifact, ProjectManifest
from backend.projects.manifest_codec import decode_manifest, encode_manifest
from backend.storage.domain import StorageRoots
from backend.version import PROJECT_FORMAT_VERSION


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
    ) -> Path:
        working = self.begin_revision(song_id, revision)
        for relative, source in files.items():
            target = working / relative
            target.parent.mkdir(parents=True, exist_ok=True)
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
        shutil.copytree(source, working)
        return working

    def publish_revision(self, song_id: str, revision: int, working: Path) -> None:
        target = self._revision_root(song_id, revision)
        if target.exists():
            raise ConflictError(
                "RevisionConflict", "Project revision already exists", revision=revision
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(working, target)
        except OSError as exc:
            raise DependencyError(
                "StorageUnavailable", "Project revision publication failed"
            ) from exc

    def snapshot_revision(self, song_id: str, revision: int, destination: Path) -> Path:
        source = self._revision_root(song_id, revision)
        if not source.is_dir():
            raise NotFoundError("ProjectInvalid", "Project revision does not exist")
        target = destination / f"revision-{revision}"
        shutil.copytree(source, target)
        return target

    def revision_exists(self, song_id: str, revision: int) -> bool:
        return self._revision_root(song_id, revision).is_dir()

    def latest_revision(self, song_id: str) -> int | None:
        root = self._roots.songs / song_id / "revisions"
        revisions = (
            [int(path.name) for path in root.iterdir() if path.is_dir() and path.name.isdigit()]
            if root.exists()
            else []
        )
        return max(revisions, default=None)

    def remove_revision(self, song_id: str, revision: int) -> None:
        shutil.rmtree(self._revision_root(song_id, revision), ignore_errors=True)

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
