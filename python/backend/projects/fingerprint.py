from __future__ import annotations

import hashlib

from backend.projects.domain import ProjectManifest


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
