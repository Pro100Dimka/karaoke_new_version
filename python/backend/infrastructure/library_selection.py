from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import NoReturn, cast

from sqlalchemy import Table, select
from sqlalchemy.engine import Connection

from backend.domain_errors import ConflictError
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.orm import (
    AnalysisRow,
    HistoryRow,
    ProjectRevisionRow,
    RecordingRow,
    SongRow,
)
from backend.infrastructure.paths import ensure_within
from backend.infrastructure.sql_time import as_utc
from backend.projects.domain import ArtifactCategory
from backend.projects.fingerprint import project_content_fingerprint
from backend.projects.manifest_codec import decode_manifest
from backend.projects.validator import READY_ARTIFACTS
from backend.serialization import loads_optional_object, loads_value
from backend.storage.domain import StorageRoots
from backend.storage.path_policy import portable_relative_path

LibraryRow = dict[str, object]
LibraryRows = dict[str, list[LibraryRow]]


def select_library_rows(
    rows: LibraryRows, connection: Connection, roots: StorageRoots, workspace: Path
) -> LibraryRows:
    songs: dict[object, object] = {
        song_id: identity
        for song_id, identity in connection.execute(
            select(SongRow.song_id, SongRow.source_identity)
        )
    }
    added = _added_songs(rows["songs"], songs)
    existing = {
        str(row["recording_id"]): dict(row)
        for row in connection.execute(select(RecordingRow.__table__)).mappings()
    }
    takes = {
        str(row["recording_id"]): row
        for row in rows["recordings"]
        if row["recording_id"] not in existing
    }
    references = _References(rows, connection, roots, workspace)
    for take in takes.values():
        if take["song_id"] not in added | {None}:
            if take["song_id"] not in songs:
                _conflict(
                    take,
                    "SongMissing",
                    "Recording reference song is absent; identities cannot be merged",
                )
            references.validate(take)
    for result in rows["analysis_results"]:
        if result["recording_id"] in takes and result["song_id"] not in added:
            references.validate(result)
    _validate_sources(rows["recordings"], takes, existing, roots, workspace)
    return _scoped_rows(rows, added, set(takes))


def _scoped_rows(rows: LibraryRows, added: set[object], take_ids: set[object]) -> LibraryRows:
    scope: dict[str, tuple[str, set[object]]] = {
        "songs": ("song_id", added),
        "project_revisions": ("song_id", added),
        "recordings": ("recording_id", take_ids),
        "analysis_results": ("recording_id", take_ids),
        "history_events": ("entity_id", added | take_ids),
    }
    return {
        name: [row for row in rows[name] if row[field] in allowed]
        for name, (field, allowed) in scope.items()
    }


def _added_songs(rows: list[LibraryRow], existing: dict[object, object]) -> set[object]:
    if any(
        row["song_id"] in existing and existing[row["song_id"]] != row["source_identity"]
        for row in rows
    ):
        raise ConflictError(
            "PackageConflict", "A different song already uses this library identity"
        )
    return {
        row["song_id"]
        for row in rows
        if row["song_id"] not in existing and row["source_identity"] not in existing.values()
    }


class _References:
    def __init__(
        self, rows: LibraryRows, connection: Connection, roots: StorageRoots, workspace: Path
    ) -> None:
        self._incoming = {(row["song_id"], row["revision"]) for row in rows["project_revisions"]}
        self._existing = set(
            connection.execute(
                select(ProjectRevisionRow.song_id, ProjectRevisionRow.revision)
            ).all()
        )
        self._roots, self._workspace = roots, workspace
        self._verified: set[tuple[str, int]] = set()

    def validate(self, take: LibraryRow) -> None:
        song_id, revision = take["song_id"], take["song_revision"]
        if not isinstance(song_id, str) or not isinstance(revision, int) or revision < 1:
            _conflict(take, "ReferenceMissing", "Recording reference revision is missing")
        key = (song_id, revision)
        if key in self._verified:
            return
        if key not in self._incoming or key not in self._existing:
            _conflict(
                take,
                "ReferenceMissing",
                "Recording reference revision is not present in both libraries",
            )
        relative = Path(song_id) / "revisions" / str(revision)
        try:
            incoming = _reference_content(self._workspace / "songs" / relative, key)
            existing = _reference_content(self._roots.songs / relative, key)
        except (OSError, ValueError) as exc:
            _conflict(
                take,
                "ReferenceUnavailable",
                "Recording reference files are incomplete or invalid",
                exc,
            )
        if incoming != existing:
            _conflict(
                take,
                "ReferenceMismatch",
                "Recording reference revision differs from the existing project",
            )
        self._verified.add(key)


def _reference_content(root: Path, key: tuple[str, int]) -> str:
    manifest = decode_manifest((root / "manifest.json").read_text(encoding="utf-8"))
    if (manifest.song_id, manifest.revision) != key:
        raise ValueError("Reference manifest identity differs")
    portable = [item for item in manifest.artifacts if item.category is ArtifactCategory.PORTABLE]
    names = [item.logical_name for item in portable]
    fingerprint = project_content_fingerprint(manifest)
    if not fingerprint or len(names) != len(set(names)) or not READY_ARTIFACTS.issubset(names):
        raise ValueError("Reference does not contain a complete portable project")
    for item in portable:
        relative = portable_relative_path(item.relative_path.as_posix())
        path = ensure_within(root / relative, root)
        if not path.is_file() or sha256_file(path) != item.checksum:
            raise ValueError("Reference artifact is missing or changed")
    return fingerprint


def _validate_sources(
    incoming: list[LibraryRow],
    added: dict[str, LibraryRow],
    existing: dict[str, LibraryRow],
    roots: StorageRoots,
    workspace: Path,
) -> None:
    available = {**existing, **added}
    incoming_ids = {str(row["recording_id"]) for row in incoming}
    affected = list(added.values()) + [row for row in existing.values() if _source_id(row) in added]
    for take in affected:
        _source_chain(take, available, incoming_ids, set(added), roots, workspace)


def _source_chain(
    take: LibraryRow,
    available: dict[str, LibraryRow],
    incoming: set[str],
    added: set[str],
    roots: StorageRoots,
    workspace: Path,
) -> None:
    visited = {str(take["recording_id"])}
    current = take
    while source_id := _source_id(current):
        if source_id in visited:
            _conflict(take, "SourceCycle", "Recording Master source links contain a cycle")
        visited.add(source_id)
        source = available.get(source_id)
        if source is None:
            if source_id in incoming:
                _conflict(take, "SourceMissing", "Recording Master source cannot be restored")
            return  # A retained Master whose original was deliberately deleted stays usable.
        if (source["song_id"], source["song_revision"]) != (
            current["song_id"],
            current["song_revision"],
        ):
            _conflict(
                take,
                "SourceReferenceMismatch",
                "Recording Master and original reference different revisions",
            )
        base = workspace if source_id in added else roots.app
        path = ensure_within(base / str(source["file_path"]), base / "recordings")
        if source["file_status"] != "Ready" or not path.is_file():
            _conflict(take, "SourceUnavailable", "Recording Master source audio is unavailable")
        current = source


def _source_id(row: LibraryRow) -> str | None:
    metadata = loads_optional_object(str(row["session_json"])) or {}
    master = metadata.get("studioMaster")
    if not isinstance(master, dict):
        return None
    source = master.get("sourceRecordingId")
    if source is not None and (not isinstance(source, str) or not source):
        _conflict(row, "SourceInvalid", "Recording Master source identity is invalid")
    return source


def deduplicate_library_history(selected: LibraryRows, connection: Connection) -> None:
    """Deleted takes keep their historical events; restore their rows without duplicate IDs."""
    for model, field in ((AnalysisRow, "analysis_id"), (HistoryRow, "event_id")):
        table = cast(Table, model.__table__)
        known = {row[field]: dict(row) for row in connection.execute(select(table)).mappings()}
        unique = []
        for row in selected[model.__tablename__]:
            previous = known.get(row[field])
            if previous is None:
                unique.append(row)
                known[row[field]] = row
            elif _comparable(previous) != _comparable(row):
                raise ConflictError(
                    "LibraryRecordingConflict",
                    "Recording history identity has different contents",
                    recordingId=row.get("recording_id", row.get("entity_id")),
                    reason="HistoryMismatch",
                )
        selected[model.__tablename__] = unique


def _comparable(row: LibraryRow) -> LibraryRow:
    values = {field: value for field, value in row.items() if field != "id"}
    for field, value in values.items():
        if isinstance(value, datetime):
            values[field] = as_utc(value)
        elif field.endswith("_json") and isinstance(value, str):
            values[field] = loads_value(value)
    return values


def _conflict(
    row: LibraryRow, reason: str, message: str, cause: Exception | None = None
) -> NoReturn:
    raise ConflictError(
        "LibraryRecordingConflict", message, recordingId=row["recording_id"], reason=reason
    ) from cause
