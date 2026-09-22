from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import PurePosixPath
from typing import Sequence

from backend.songs.domain import Language


class PackageCompatibility(StrEnum):
    CURRENT = "Current"
    UPGRADEABLE = "Upgradeable"
    TOO_NEW = "TooNew"
    UNSUPPORTED = "Unsupported"
    CORRUPT = "Corrupt"


class PackageImportDecision(StrEnum):
    SAFE_ONLY = "SafeOnly"
    ACCEPT_OLDER = "AcceptOlder"
    ACCEPT_DIVERGENT = "AcceptDivergent"


class PackageConflict(StrEnum):
    NONE = "None"
    SAME_REVISION = "SameRevision"
    NEWER_REVISION = "NewerRevision"
    OLDER_REVISION = "OlderRevision"
    DIVERGENT_REVISION = "DivergentRevision"


@dataclass(frozen=True, slots=True)
class PackageArtifact:
    path: PurePosixPath
    checksum: str


@dataclass(frozen=True, slots=True)
class PackageSongIdentity:
    song_id: str
    source_identity: str
    title: str
    artist: str
    duration: float | None
    language: Language
    album: str | None = None
    genre: str | None = None
    artwork_url: str | None = None
    video_url: str | None = None
    recognition_provider: str | None = None
    recognition_external_id: str | None = None


@dataclass(frozen=True, slots=True)
class PackageManifest:
    package_version: int
    project_format_version: int
    song: PackageSongIdentity
    revision: int
    revision_fingerprint: str
    lineage_id: str
    artifacts: Sequence[PackageArtifact]
