from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime
from enum import StrEnum
from pathlib import Path


class SongStatus(StrEnum):
    IMPORTED = "Imported"
    QUEUED = "Queued"
    PROCESSING = "Processing"
    CANCELLING = "Cancelling"
    CANCELLED = "Cancelled"
    READY = "Ready"
    FAILED = "Failed"
    PROJECT_INVALID = "ProjectInvalid"
    SOURCE_MISSING = "SourceMissing"


class SourceState(StrEnum):
    MANAGED = "Managed"
    PACKAGE_ONLY = "PackageOnly"


class Language(StrEnum):
    AUTO = "Auto"
    UKRAINIAN = "Ukrainian"
    RUSSIAN = "Russian"
    ENGLISH = "English"


class CoverState(StrEnum):
    EMBEDDED = "Embedded"
    CUSTOM = "Custom"
    FALLBACK = "Fallback"


class MetadataSource(StrEnum):
    EMBEDDED = "Embedded"
    FILENAME = "Filename"
    DETECTED = "Detected"
    USER = "User"


@dataclass(frozen=True, slots=True)
class Song:
    song_id: str
    title: str
    artist: str
    source_identity: str
    source_state: SourceState
    source_path: Path | None
    status: SongStatus
    active_revision: int
    project_format_version: int
    created_at: datetime
    updated_at: datetime
    album: str | None = None
    duration: float | None = None
    media_format: str | None = None
    language: Language = Language.AUTO
    cover_state: CoverState = CoverState.FALLBACK
    cover_path: Path | None = None
    embedded_lyrics: str | None = None
    metadata_provenance: dict[str, MetadataSource] = field(default_factory=dict)
    user_overrides: frozenset[str] = frozenset()

    def with_status(self, status: SongStatus, updated_at: datetime) -> "Song":
        return replace(self, status=status, updated_at=updated_at)
