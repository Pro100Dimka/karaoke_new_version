from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath

from backend.domain_errors import ConflictError, DomainError
from backend.packages.codec import decode_manifest
from backend.packages.domain import PackageCompatibility, PackageConflict, PackageManifest
from backend.packages.ports import PackageArchive
from backend.packages.security import PackageSecurityValidator
from backend.persistence import UnitOfWorkFactory
from backend.projects.domain import ProjectRevision
from backend.projects.ports import ProjectStorage
from backend.projects.fingerprint import manifest_fingerprint, project_content_fingerprint
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
    local_revision: int | None = None
    matches_existing_revision: bool = False


class InspectPackage:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        archive: PackageArchive,
        security: PackageSecurityValidator,
        projects: ProjectStorage,
    ) -> None:
        self._uow = uow
        self._archive = archive
        self._security = security
        self._projects = projects

    def execute(self, path: Path) -> PackageInspection:
        entries = self._archive.inspect(path)
        self._security.validate(entries)
        manifest = self._decode(path)
        compatibility = _compatibility(manifest)
        existing, revision = self._existing(manifest)
        conflict = _conflict(manifest, existing, revision)
        matches_existing = conflict is PackageConflict.SAME_REVISION
        if matches_existing and self._hides_newer_content(manifest, existing, revision):
            conflict = PackageConflict.OLDER_REVISION
        size = sum(entry.file_size for entry in entries)
        return PackageInspection(
            manifest,
            compatibility,
            conflict,
            existing.song_id if existing else (manifest.song.song_id if revision else None),
            size,
            revision.revision if revision else None,
            matches_existing,
        )

    def _hides_newer_content(
        self, manifest: PackageManifest, song: Song | None, revision: ProjectRevision | None
    ) -> bool:
        if song is None or revision is None or revision.revision >= song.active_revision:
            return False
        try:
            old = self._projects.load_manifest(song.song_id, revision.revision)
            active = self._projects.load_manifest(song.song_id, song.active_revision)
        except DomainError:
            return True
        incoming = project_content_fingerprint(old, manifest.song.video_url)
        current = project_content_fingerprint(active, song.video_url)
        return incoming is None or incoming != current

    def _decode(self, path: Path) -> PackageManifest:
        try:
            return decode_manifest(self._archive.read_text(path, _MANIFEST, max_bytes=1024 * 1024))
        except (ValueError, KeyError) as exc:
            raise DomainError("PackageInvalid", "Package manifest is malformed", 400) from exc

    def _existing(self, manifest: PackageManifest) -> tuple[Song | None, ProjectRevision | None]:
        with self._uow.create() as transaction:
            song = transaction.songs.get_by_source_identity(manifest.song.source_identity)
            if song is None and transaction.songs.get(manifest.song.song_id) is not None:
                raise ConflictError(
                    "PackageConflict", "A different song already uses this project identity"
                )
            revision = transaction.projects.get(
                song.song_id if song else manifest.song.song_id,
                manifest.revision,
            )
            song_id = song.song_id if song else manifest.song.song_id
            if revision is not None and revision.fingerprint == manifest.revision_fingerprint:
                return song, revision
            candidates = sorted(self._projects.revisions(song_id), reverse=True)
            for candidate in candidates:
                stored = transaction.projects.get(song_id, candidate)
                if stored is None:
                    continue
                try:
                    project = self._projects.load_manifest(song_id, candidate)
                except DomainError:
                    continue
                if (
                    candidate != manifest.revision
                    and project.provenance.get("importedRevisionFingerprint")
                    != manifest.revision_fingerprint
                ):
                    continue
                normalized = replace(
                    project, song_id=manifest.song.song_id, revision=manifest.revision
                )
                if manifest_fingerprint(normalized) == manifest.revision_fingerprint:
                    return song, replace(stored, fingerprint=manifest.revision_fingerprint)
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
    if revision is not None:
        fingerprint = revision.fingerprint
        return (
            PackageConflict.SAME_REVISION
            if fingerprint == manifest.revision_fingerprint
            else PackageConflict.DIVERGENT_REVISION
        )
    if song is None:
        return PackageConflict.NONE
    active_revision = song.active_revision
    if manifest.revision > active_revision:
        return PackageConflict.NEWER_REVISION
    if manifest.revision < active_revision:
        return PackageConflict.OLDER_REVISION
    return PackageConflict.DIVERGENT_REVISION
