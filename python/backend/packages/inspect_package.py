from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from backend.domain_errors import DomainError
from backend.packages.codec import decode_manifest
from backend.packages.domain import PackageCompatibility, PackageConflict, PackageManifest
from backend.packages.ports import PackageArchive
from backend.packages.security import PackageSecurityValidator
from backend.persistence import UnitOfWorkFactory
from backend.projects.domain import ProjectRevision
from backend.songs.domain import Song
from backend.version import PACKAGE_FORMAT_VERSION, PROJECT_FORMAT_VERSION

_MANIFEST = PurePosixPath("package.json")


@dataclass(frozen=True, slots=True)
class PackageInspection:
    manifest: PackageManifest
    compatibility: PackageCompatibility
    conflict: PackageConflict
    existing_song_id: str | None
    uncompressed_bytes: int


class InspectPackage:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        archive: PackageArchive,
        security: PackageSecurityValidator,
    ) -> None:
        self._uow = uow
        self._archive = archive
        self._security = security

    def execute(self, path: Path) -> PackageInspection:
        entries = self._archive.inspect(path)
        self._security.validate(entries)
        manifest = self._decode(path)
        compatibility = _compatibility(manifest)
        existing, revision = self._existing(manifest)
        conflict = _conflict(manifest, existing, revision)
        size = sum(entry.file_size for entry in entries)
        return PackageInspection(
            manifest, compatibility, conflict, existing.song_id if existing else None, size
        )

    def _decode(self, path: Path) -> PackageManifest:
        try:
            return decode_manifest(self._archive.read_text(path, _MANIFEST, max_bytes=1024 * 1024))
        except (ValueError, KeyError) as exc:
            raise DomainError("PackageInvalid", "Package manifest is malformed", 400) from exc

    def _existing(self, manifest: PackageManifest) -> tuple[Song | None, ProjectRevision | None]:
        with self._uow.create() as transaction:
            song = transaction.songs.get_by_source_identity(manifest.song.source_identity)
            revision = transaction.projects.get(song.song_id, manifest.revision) if song else None
        return song, revision


def _compatibility(manifest: PackageManifest) -> PackageCompatibility:
    if manifest.package_version > PACKAGE_FORMAT_VERSION:
        return PackageCompatibility.TOO_NEW
    if manifest.package_version < PACKAGE_FORMAT_VERSION:
        return PackageCompatibility.UNSUPPORTED
    if manifest.project_format_version == PROJECT_FORMAT_VERSION:
        return PackageCompatibility.CURRENT
    if manifest.project_format_version == PROJECT_FORMAT_VERSION - 1:
        return PackageCompatibility.UPGRADEABLE
    if manifest.project_format_version > PROJECT_FORMAT_VERSION:
        return PackageCompatibility.TOO_NEW
    return PackageCompatibility.UNSUPPORTED


def _conflict(
    manifest: PackageManifest,
    song: Song | None,
    revision: ProjectRevision | None,
) -> PackageConflict:
    if song is None:
        return PackageConflict.NONE
    if revision is not None:
        fingerprint = revision.fingerprint
        return (
            PackageConflict.SAME_REVISION
            if fingerprint == manifest.revision_fingerprint
            else PackageConflict.DIVERGENT_REVISION
        )
    active_revision = song.active_revision
    if manifest.revision > active_revision:
        return PackageConflict.NEWER_REVISION
    if manifest.revision < active_revision:
        return PackageConflict.OLDER_REVISION
    return PackageConflict.DIVERGENT_REVISION
