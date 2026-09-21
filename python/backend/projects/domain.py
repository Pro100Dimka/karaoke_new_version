from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from datetime import datetime
from pathlib import Path
from typing import Mapping, Sequence


class ArtifactCategory(StrEnum):
    PORTABLE = "Portable"
    LOCAL_ONLY = "LocalOnly"
    TEMPORARY = "Temporary"


class ProjectCompatibility(StrEnum):
    CURRENT = "Current"
    UPGRADEABLE = "Upgradeable"
    TOO_NEW = "TooNew"
    UNSUPPORTED = "Unsupported"
    INVALID = "Invalid"


@dataclass(frozen=True, slots=True)
class ProjectArtifact:
    logical_name: str
    relative_path: Path
    category: ArtifactCategory
    checksum: str | None = None
    version: str | None = None
    provenance: Mapping[str, str] | None = None


@dataclass(frozen=True, slots=True)
class ProjectManifest:
    project_format_version: int
    song_id: str
    revision: int
    artifacts: Sequence[ProjectArtifact]
    provenance: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class ProjectRevision:
    song_id: str
    revision: int
    fingerprint: str
    project_format_version: int
    lineage_id: str
    created_at: datetime
