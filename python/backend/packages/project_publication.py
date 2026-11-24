from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
from pathlib import PurePosixPath
from typing import Callable

from backend.domain_errors import DomainError
from backend.packages.domain import PackageCompatibility
from backend.packages.inspect_package import PackageInspection
from backend.packages.ports import PackageArchive, PackageFileHasher
from backend.projects.domain import ProjectManifest
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import decode_manifest, encode_manifest
from backend.projects.ports import ProjectStorage
from backend.projects.validator import ProjectValidator
from backend.recovery.domain import RecoveryEntry, RecoveryOperation
from backend.recovery.ports import RecoveryJournal
from backend.storage.ports import WorkStorage
from backend.version import PROJECT_FORMAT_VERSION


@dataclass(frozen=True, slots=True)
class PublishedPackageProject:
    recovery_entry: RecoveryEntry
    fingerprint: str
    project_format_version: int
    revision: int
    custom_cover: Path | None = None


class PackageProjectPublication:
    """Validates, upgrades when supported, and atomically publishes package files."""

    def __init__(
        self,
        archive: PackageArchive,
        projects: ProjectStorage,
        validator: ProjectValidator,
        workspaces: WorkStorage,
        journal: RecoveryJournal,
        hasher: PackageFileHasher,
    ) -> None:
        self._archive = archive
        self._projects = projects
        self._validator = validator
        self._workspaces = workspaces
        self._journal = journal
        self._hasher = hasher

    def execute(
        self,
        archive_path: Path,
        inspection: PackageInspection,
        song_id: str,
        *,
        install_cover: Callable[[Path], Path] | None = None,
        ensure_not_cancelled: Callable[[], None] | None = None,
    ) -> PublishedPackageProject:
        workspace = self._workspaces.allocate(f"import-{song_id}")
        published = False
        try:
            project = self._prepare_project(
                archive_path, inspection, song_id, workspace, ensure_not_cancelled,
            )
            cover = self._install_cover(inspection, workspace, install_cover)
            if ensure_not_cancelled:
                ensure_not_cancelled()
            # Once published, return its rollback handle before any further cancellation check.
            entry = self._journal.begin(
                RecoveryOperation.PACKAGE_IMPORT,
                {"songId": song_id, "revision": project.revision},
            )
            self._projects.publish_revision(
                song_id,
                project.revision,
                workspace,
            )
            published = True
            return PublishedPackageProject(
                entry,
                manifest_fingerprint(project),
                project.project_format_version,
                project.revision,
                cover,
            )
        finally:
            if not published:
                self._workspaces.cleanup(workspace)

    def complete(self, published: PublishedPackageProject) -> None:
        self._journal.complete(published.recovery_entry.transaction_id)

    def _prepare_project(
        self,
        archive_path: Path,
        inspection: PackageInspection,
        song_id: str,
        workspace: Path,
        ensure_not_cancelled: Callable[[], None] | None,
    ) -> ProjectManifest:
        self._extract_verified(archive_path, inspection, workspace, ensure_not_cancelled)
        project = self._read_project(workspace)
        self._validate_identity(inspection, project)
        project = self._local_project(project, inspection, song_id, workspace)
        project = self._upgrade_if_supported(inspection, project, workspace)
        self._validator.validate_working(
            project, workspace, require_ready=True,
            hasher=lambda path: self._hasher(path, ensure_not_cancelled),
            ensure_not_cancelled=ensure_not_cancelled,
        )
        return project

    def _extract_verified(
        self,
        archive_path: Path,
        inspection: PackageInspection,
        workspace: Path,
        ensure_not_cancelled: Callable[[], None] | None,
    ) -> None:
        self._archive.extract(
            archive_path, workspace,
            progress=(lambda _: ensure_not_cancelled()) if ensure_not_cancelled else None,
        )
        self._verify_artifacts(inspection, workspace, ensure_not_cancelled)

    def _local_project(
        self, project: ProjectManifest, inspection: PackageInspection, song_id: str, workspace: Path
    ) -> ProjectManifest:
        revision = (
            inspection.local_revision if inspection.matches_existing_revision else None
        ) or inspection.manifest.revision
        if self._projects.revision_exists(song_id, revision):
            revision = max(self._projects.revisions(song_id), default=revision) + 1
        if (project.song_id, project.revision) == (song_id, revision):
            return project
        project = replace(
            project,
            song_id=song_id,
            revision=revision,
            provenance={
                **project.provenance,
                "importedRevisionFingerprint": inspection.manifest.revision_fingerprint,
            },
        )
        self._projects.write_working_text(
            workspace, Path("manifest.json"), encode_manifest(project)
        )
        return project

    def revision_exists(self, song_id: str, revision: int) -> bool:
        return self._projects.revision_exists(song_id, revision)

    def supplement_same_revision(
        self,
        archive_path: Path,
        inspection: PackageInspection,
        song_id: str,
        *,
        install_cover: Callable[[Path], Path] | None = None,
        publish_artifact: Callable[[Path, Path], None] | None = None,
        ensure_not_cancelled: Callable[[], None] | None = None,
    ) -> Path | None:
        clip_path = PurePosixPath("media/clip.mp4")
        has_clip = any(item.path == clip_path for item in inspection.manifest.artifacts)
        if not has_clip and inspection.manifest.song.custom_cover is None:
            return None
        workspace = self._workspaces.allocate(f"supplement-{song_id}")
        try:
            self._extract_verified(archive_path, inspection, workspace, ensure_not_cancelled)
            cover = self._install_cover(inspection, workspace, install_cover)
            if ensure_not_cancelled:
                ensure_not_cancelled()
            if has_clip:
                self._projects.install_revision_artifact(
                    song_id,
                    inspection.local_revision or inspection.manifest.revision,
                    Path(*clip_path.parts),
                    workspace.joinpath(*clip_path.parts),
                    publish=publish_artifact,
                    ensure_not_cancelled=ensure_not_cancelled,
                )
            return cover
        finally:
            self._workspaces.cleanup(workspace)

    @staticmethod
    def _install_cover(
        inspection: PackageInspection,
        workspace: Path,
        install: Callable[[Path], Path] | None,
    ) -> Path | None:
        cover = inspection.manifest.song.custom_cover
        return install(workspace.joinpath(*cover.parts)) if cover and install else None

    def rollback(self, published: PublishedPackageProject) -> None:
        data = published.recovery_entry.data
        song_id, revision = data["songId"], data["revision"]
        if (
            not isinstance(song_id, str)
            or isinstance(revision, bool)
            or not isinstance(revision, int)
        ):
            raise ValueError("Invalid package publication identity")
        self._projects.remove_revision(song_id, revision)
        self._journal.complete(published.recovery_entry.transaction_id)

    def _verify_artifacts(
        self,
        inspection: PackageInspection,
        workspace: Path,
        ensure_not_cancelled: Callable[[], None] | None = None,
    ) -> None:
        for artifact in inspection.manifest.artifacts:
            target = workspace.joinpath(*artifact.path.parts)
            if not target.is_file():
                self._checksum_error(artifact.path.as_posix())
            if self._hasher(target, ensure_not_cancelled) != artifact.checksum:
                self._checksum_error(artifact.path.as_posix())

    @staticmethod
    def _read_project(workspace: Path) -> ProjectManifest:
        try:
            return decode_manifest((workspace / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DomainError("PackageInvalid", "Project manifest is invalid", 400) from exc

    @staticmethod
    def _validate_identity(
        inspection: PackageInspection,
        project: ProjectManifest,
    ) -> None:
        identity_matches = project.song_id == inspection.manifest.song.song_id
        revision_matches = project.revision == inspection.manifest.revision
        if not identity_matches or not revision_matches:
            raise DomainError(
                "PackageInvalid",
                "Project identity does not match package manifest",
                400,
            )

    def _upgrade_if_supported(
        self,
        inspection: PackageInspection,
        project: ProjectManifest,
        workspace: Path,
    ) -> ProjectManifest:
        if inspection.compatibility is not PackageCompatibility.UPGRADEABLE:
            return project
        if project.project_format_version != PROJECT_FORMAT_VERSION - 1:
            raise DomainError(
                "PackageVersionUnsupported",
                "Package project format cannot be upgraded",
                409,
            )
        upgraded = replace(project, project_format_version=PROJECT_FORMAT_VERSION)
        self._projects.write_working_text(
            workspace,
            Path("manifest.json"),
            encode_manifest(upgraded),
        )
        return upgraded

    @staticmethod
    def _checksum_error(path: str) -> None:
        raise DomainError(
            "PackageInvalid",
            "Package artifact checksum failed",
            400,
            {"path": path},
        )
