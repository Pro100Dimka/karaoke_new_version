from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

from backend.domain_errors import DomainError
from backend.packages.domain import PackageCompatibility
from backend.packages.inspect_package import PackageInspection
from backend.packages.ports import PackageArchive
from backend.projects.domain import ProjectManifest
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import decode_manifest, encode_manifest
from backend.projects.ports import ProjectStorage
from backend.projects.validator import ProjectValidator
from backend.recovery.domain import RecoveryEntry, RecoveryOperation
from backend.recovery.ports import RecoveryJournal
from backend.songs.ports import FileHasher
from backend.storage.ports import WorkStorage
from backend.version import PROJECT_FORMAT_VERSION


@dataclass(frozen=True, slots=True)
class PublishedPackageProject:
    recovery_entry: RecoveryEntry
    fingerprint: str
    project_format_version: int


class PackageProjectPublication:
    """Validates, upgrades when supported, and atomically publishes package files."""

    def __init__(
        self,
        archive: PackageArchive,
        projects: ProjectStorage,
        validator: ProjectValidator,
        workspaces: WorkStorage,
        journal: RecoveryJournal,
        hasher: FileHasher,
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
    ) -> PublishedPackageProject:
        workspace = self._workspaces.allocate(f"import-{song_id}")
        published = False
        try:
            self._archive.extract(archive_path, workspace)
            self._verify_artifacts(inspection, workspace)
            project = self._read_project(workspace)
            self._validate_identity(inspection, project)
            if project.song_id != song_id:
                project = replace(project, song_id=song_id)
                self._projects.write_working_text(
                    workspace,
                    Path("manifest.json"),
                    encode_manifest(project),
                )
            project = self._upgrade_if_supported(inspection, project, workspace)
            self._validator.validate_working(project, workspace, require_ready=True)
            entry = self._journal.begin(
                RecoveryOperation.PACKAGE_IMPORT,
                {"songId": song_id, "revision": inspection.manifest.revision},
            )
            self._projects.publish_revision(
                song_id,
                inspection.manifest.revision,
                workspace,
            )
            published = True
            return PublishedPackageProject(
                entry,
                manifest_fingerprint(project),
                project.project_format_version,
            )
        finally:
            if not published:
                self._workspaces.cleanup(workspace)

    def complete(self, published: PublishedPackageProject) -> None:
        self._journal.complete(published.recovery_entry.transaction_id)

    def revision_exists(self, song_id: str, revision: int) -> bool:
        return self._projects.revision_exists(song_id, revision)

    def rollback(self, published: PublishedPackageProject) -> None:
        data = published.recovery_entry.data
        self._projects.remove_revision(str(data["songId"]), int(data["revision"]))
        self._journal.complete(published.recovery_entry.transaction_id)

    def _verify_artifacts(
        self,
        inspection: PackageInspection,
        workspace: Path,
    ) -> None:
        for artifact in inspection.manifest.artifacts:
            target = workspace.joinpath(*artifact.path.parts)
            if not target.is_file():
                self._checksum_error(artifact.path.as_posix())
            if self._hasher.hash_file(target) != artifact.checksum:
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
