from __future__ import annotations

import hashlib

from backend.projects.domain import ArtifactCategory, ProjectManifest


def project_content_fingerprint(manifest: ProjectManifest, video: str | None = None) -> str | None:
    artifacts = sorted(
        (a for a in manifest.artifacts if a.category is ArtifactCategory.PORTABLE),
        key=lambda a: a.logical_name,
    )
    if not artifacts or any(not a.checksum for a in artifacts):
        return None
    digest = hashlib.sha256(str(manifest.project_format_version).encode())
    for artifact in artifacts:
        digest.update(f"\0{artifact.logical_name}\0{artifact.checksum}".encode())
    if video is not None:
        digest.update(f"\0video\0{video}".encode())
    return digest.hexdigest()


def manifest_fingerprint(manifest: ProjectManifest) -> str:
    digest = hashlib.sha256()
    digest.update(str(manifest.project_format_version).encode())
    digest.update(manifest.song_id.encode())
    digest.update(str(manifest.revision).encode())
    for artifact in sorted(manifest.artifacts, key=lambda item: item.logical_name):
        digest.update(artifact.logical_name.encode())
        digest.update(artifact.relative_path.as_posix().encode())
        digest.update(artifact.category.value.encode())
        digest.update((artifact.checksum or "").encode())
    return digest.hexdigest()
