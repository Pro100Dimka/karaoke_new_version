from __future__ import annotations

import math
import logging
import os
import shutil
from dataclasses import replace
from datetime import datetime
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Callable, Mapping, Sequence, cast

from sqlalchemy import DateTime, Float, MetaData, Table, select
from sqlalchemy.engine import Connection

from backend.analysis.domain import AnalysisState
from backend.domain_errors import ConflictError
from backend.infrastructure.database import Database
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.orm import (
    AnalysisRow,
    HistoryRow,
    ProjectRevisionRow,
    RecordingRow,
    SongRow,
)
from backend.infrastructure.paths import ensure_within
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import decode_manifest, encode_manifest
from backend.recovery.domain import RecoveryEntry, RecoveryOperation
from backend.recovery.ports import RecoveryJournal
from backend.serialization import dumps, loads_value
from backend.songs.domain import CoverState, Language, SongStatus, SourceState
from backend.storage.domain import StorageRoots
from backend.storage.path_policy import portable_component, portable_relative_path
from backend.storage.ports import StorageSystem

LibraryRow = dict[str, object]
LibraryRows = dict[str, list[LibraryRow]]
_TABLES: Mapping[str, Table] = MappingProxyType(
    {
        row.__tablename__: cast(Table, row.__table__)
        for row in (SongRow, ProjectRevisionRow, RecordingRow, AnalysisRow, HistoryRow)
    }
)
_PATHS: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
        "songs": ("source_path", "cover_path"),
        "recordings": ("file_path",),
    }
)
logger = logging.getLogger(__name__)


class SqlLibraryStorage:
    """Portable library rows and media, merged without replacing the recipient's data."""

    def __init__(
        self, database: Database, roots: StorageRoots, storage: StorageSystem, margin: int,
        journal: RecoveryJournal,
    ) -> None:
        self._database, self._roots = database, roots
        self._storage, self._margin = storage, margin
        self._journal = journal

    def export_path(self, job_id: str) -> Path:
        return self._roots.app / "exports" / f"library-{portable_component(job_id)}.advoice.zip"

    def require_free(self, required_bytes: int) -> None:
        self._storage.require_free(self._roots.app, self._margin + required_bytes)

    def relocate(self, transform: Callable[[object], object]) -> tuple[tuple[str, int], ...]:
        """Rebase a copied database and its revision references without changing identities."""
        metadata = MetaData()
        with self._database.engine.begin() as connection:
            metadata.reflect(bind=connection)
            for table in metadata.tables.values():
                if "id" not in table.c:
                    continue
                for record in connection.execute(select(table)).mappings().all():
                    changes: LibraryRow = {}
                    for field, value in record.items():
                        if not isinstance(value, str):
                            continue
                        if field.endswith("_json"):
                            try:
                                parsed = loads_value(value)
                            except ValueError:
                                continue
                            relocated = transform(parsed)
                            if relocated != parsed:
                                changes[field] = dumps(relocated)
                        elif field.endswith("_path"):
                            relocated = transform(value)
                            if relocated != value:
                                changes[field] = relocated
                    if changes:
                        connection.execute(table.update().where(table.c.id == record["id"]).values(**changes))
        rows = self._snapshot_rows(self.song_ids())
        for row in rows["songs"]:
            portable_component(str(row["song_id"]))
        sources = {row["song_id"]: row["source_path"] for row in rows["songs"]}
        candidates: list[LibraryRow] = []
        for row in rows["project_revisions"]:
            revision = int(str(row["revision"]))
            if revision < 1:
                raise ValueError("Invalid project revision")
            root = self._roots.songs / str(row["song_id"]) / "revisions" / str(revision)
            if not sources.get(row["song_id"]):
                continue
            if not (root / "manifest.json").is_file() or not (root / "source.ref").is_file():
                continue
            try:
                project = decode_manifest((root / "manifest.json").read_text(encoding="utf-8"))
            except ValueError:
                logger.warning("Existing revision metadata is invalid; copied unchanged: %s", root)
                continue
            if any(item.relative_path.root or item.relative_path.drive or ".." in item.relative_path.parts for item in project.artifacts):
                logger.warning("Existing revision has unsafe artifact paths; copied unchanged: %s", root)
                continue
            candidates.append(row)
        rows["project_revisions"] = candidates
        self._source_references(rows, self._roots.app)
        with self._database.engine.begin() as connection:
            table = _TABLES["project_revisions"]
            for row in rows["project_revisions"]:
                connection.execute(table.update().where(table.c.id == row["id"]).values(fingerprint=row["fingerprint"]))
        return tuple((str(row["song_id"]), int(str(row["revision"]))) for row in candidates)

    def song_ids(self) -> tuple[str, ...]:
        with self._database.engine.connect() as connection:
            return tuple(connection.scalars(select(SongRow.song_id).order_by(SongRow.song_id)))

    def snapshot(
        self, song_ids: Sequence[str]
    ) -> tuple[dict[str, object], dict[PurePosixPath, Path]]:
        rows = self._snapshot_rows(song_ids)
        files = self._snapshot_files(rows, song_ids)
        self._portable_rows(rows)
        return dict(rows), files

    def _snapshot_rows(self, song_ids: Sequence[str]) -> LibraryRows:
        with self._database.engine.connect() as connection:
            rows: LibraryRows = {
                name: [dict(row) for row in connection.execute(select(table)).mappings()]
                for name, table in _TABLES.items()
            }
        ids: set[object] = set(song_ids)
        recordings = {
            row["recording_id"] for row in rows["recordings"] if row["song_id"] in ids | {None}
        }
        scope = {
            "songs": ("song_id", ids),
            "project_revisions": ("song_id", ids),
            "recordings": ("song_id", ids | {None}),
            "analysis_results": ("recording_id", recordings),
            "history_events": ("entity_id", ids | recordings),
        }
        return {
            name: [row for row in rows[name] if row[field] in allowed]
            for name, (field, allowed) in scope.items()
        }

    def _snapshot_files(
        self, rows: LibraryRows, song_ids: Sequence[str]
    ) -> dict[PurePosixPath, Path]:
        files: dict[PurePosixPath, Path] = {}
        for song_id in song_ids:
            root = self._roots.songs / portable_component(song_id)
            for source in root.rglob("*"):
                if source.is_file() and not any(
                    part.startswith(".") for part in source.relative_to(root).parts
                ):
                    self._file(files, source)
        for recording in rows["recordings"]:
            source = ensure_within(Path(str(recording["file_path"])), self._roots.recordings)
            for companion in source.parent.glob(f"{source.stem}*"):
                if companion.is_file():
                    self._file(files, companion)
        return files

    def _file(self, files: dict[PurePosixPath, Path], source: Path) -> None:
        source = ensure_within(source, self._roots.app)
        files[PurePosixPath(source.relative_to(self._roots.app).as_posix())] = source

    def _portable_rows(self, rows: LibraryRows) -> None:
        for name, records in rows.items():
            for row in records:
                row.pop("id")
                for field in _PATHS.get(name, ()):
                    if row[field]:
                        row[field] = (
                            ensure_within(Path(str(row[field])), self._roots.app)
                            .relative_to(self._roots.app)
                            .as_posix()
                        )
                self._relocate_json(row, portable=True)

    def restore(self, data: dict[str, object], workspace: Path) -> dict[str, int]:
        rows = _validated_rows(data)
        self._validate_identities(rows)
        self._validate_paths(rows)
        self._validate_files(rows, workspace)
        published: list[Path] = []
        entries: list[RecoveryEntry] = []
        committed = False
        try:
            with self._database.engine.begin() as connection:
                selected = self._selected_rows(rows, connection)
                self._local_paths(selected)
                self._source_references(selected, workspace)
                self._publish_files(selected, workspace, published, entries)
                for name, records in selected.items():
                    if records:
                        connection.execute(_TABLES[name].insert(), records)
            committed = True
            added = len(selected["songs"])
            return {"imported": added, "skipped": len(rows["songs"]) - added}
        finally:
            if not committed:
                self._rollback(published)
            for entry in entries:
                self._journal.complete(entry.transaction_id)

    def _validate_identities(self, rows: LibraryRows) -> None:
        songs = _identities(rows["songs"], "song_id")
        recordings = _identities(rows["recordings"], "recording_id")
        for row in rows["songs"]:
            for field, enum in {
                "status": SongStatus,
                "source_state": SourceState,
                "language": Language,
                "cover_state": CoverState,
            }.items():
                enum(str(row[field]))
        for row in rows["project_revisions"]:
            if row["song_id"] not in songs or int(str(row["revision"])) < 1:
                raise ValueError("Invalid project identity")
        for row in rows["recordings"]:
            if row["song_id"] is not None and row["song_id"] not in songs:
                raise ValueError("Invalid recording song")
        for row in rows["analysis_results"]:
            AnalysisState(str(row["state"]))
            if row["recording_id"] not in recordings or row["song_id"] not in songs:
                raise ValueError("Invalid analysis identity")

    def _validate_paths(self, rows: LibraryRows) -> None:
        for name, fields in _PATHS.items():
            identity_field = {"songs": "song_id", "recordings": "recording_id"}[name]
            for row in rows[name]:
                for field in fields:
                    if not row[field]:
                        continue
                    path = portable_relative_path(str(row[field]))
                    expected = (name, str(row[identity_field]))
                    if path.parts[: len(expected)] != expected:
                        raise ValueError("File path is outside its library item")
                    if name == "recordings" and len(path.parts) != 3:
                        raise ValueError("Recording file must be inside its own directory")

    def _validate_files(self, rows: LibraryRows, workspace: Path) -> None:
        songs = {str(row["song_id"]) for row in rows["songs"]}
        recording_paths = [PurePosixPath(str(row["file_path"])) for row in rows["recordings"]]
        files = [
            path for path in workspace.rglob("*")
            if path.is_file() and path != workspace / "library.json"
        ]
        for source in files:
            path = PurePosixPath(source.relative_to(workspace).as_posix())
            song_file = len(path.parts) > 2 and path.parts[0] == "songs" and path.parts[1] in songs
            recording_file = any(
                path.parent == base.parent and path.name.startswith(base.stem)
                for base in recording_paths
            )
            if not song_file and not recording_file:
                raise ValueError("Archive contains a file outside its library items")
        if any(not (workspace / path).is_file() for path in recording_paths):
            raise ValueError("Recording file is missing from the archive")

    def _added_songs(self, rows: LibraryRows, connection: Connection) -> set[object]:
        existing = {
            song_id: identity
            for song_id, identity in connection.execute(
                select(SongRow.song_id, SongRow.source_identity)
            )
        }
        if any(
            row["song_id"] in existing and existing[row["song_id"]] != row["source_identity"]
            for row in rows["songs"]
        ):
            raise ConflictError(
                "PackageConflict", "A different song already uses this library identity"
            )
        return {
            row["song_id"]
            for row in rows["songs"]
            if row["song_id"] not in existing and row["source_identity"] not in existing.values()
        }

    def _selected_rows(self, rows: LibraryRows, connection: Connection) -> LibraryRows:
        added = self._added_songs(rows, connection)
        known_recordings = set(connection.scalars(select(RecordingRow.recording_id)))
        takes = {
            row["recording_id"]
            for row in rows["recordings"]
            if row["recording_id"] not in known_recordings and row["song_id"] in added | {None}
        }
        scope = {
            "songs": ("song_id", added),
            "project_revisions": ("song_id", added),
            "recordings": ("recording_id", takes),
            "analysis_results": ("recording_id", takes),
            "history_events": ("entity_id", added | takes),
        }
        return {
            name: [row for row in rows[name] if row[field] in allowed]
            for name, (field, allowed) in scope.items()
        }

    def _local_paths(self, rows: LibraryRows) -> None:
        for name, records in rows.items():
            for row in records:
                for field in _PATHS.get(name, ()):
                    if row[field]:
                        row[field] = str(
                            ensure_within(self._roots.app / str(row[field]), self._roots.app)
                        )
                self._relocate_json(row, portable=False)

    def _publish_files(
        self, selected: LibraryRows, workspace: Path, published: list[Path],
        entries: list[RecoveryEntry],
    ) -> None:
        groups = (
            ("songs", "song_id", "songId", RecoveryOperation.IMPORT_SONG),
            ("recordings", "recording_id", "recordingId", RecoveryOperation.RECORDING_REGISTER),
        )
        for folder, field, key, operation in groups:
            for row in selected[folder]:
                identity = str(row[field])
                source = workspace / folder / identity
                target = ensure_within(self._roots.app / folder / identity, self._roots.app)
                if target.exists():
                    raise ConflictError("PackageConflict", "Library files already exist at the import target")
                if not source.is_dir():
                    raise ValueError("Library item directory is missing from the archive")
                data: dict[str, object] = {key: identity}
                if folder == "recordings":
                    data["filePath"] = row["file_path"]
                # Persist intent before moving bytes; startup can undo an uncommitted import.
                entries.append(self._journal.begin(operation, data))
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(source, target)
                published.append(target)

    @staticmethod
    def _rollback(published: list[Path]) -> None:
        for target in reversed(published):
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink(missing_ok=True)

    def _source_references(self, selected: LibraryRows, workspace: Path) -> None:
        sources = {row["song_id"]: row["source_path"] for row in selected["songs"]}
        for revision in selected["project_revisions"]:
            root = (
                workspace
                / "songs"
                / str(revision["song_id"])
                / "revisions"
                / str(revision["revision"])
            )
            reference = root / "source.ref"
            if reference.exists() and sources[revision["song_id"]]:
                source = str(sources[revision["song_id"]])
                atomic_write_text(reference, source)
                manifest_path = root / "manifest.json"
                project = decode_manifest(manifest_path.read_text(encoding="utf-8"))
                project = replace(
                    project,
                    artifacts=tuple(
                        replace(item, checksum=sha256_file(reference))
                        if item.relative_path == Path("source.ref")
                        else item
                        for item in project.artifacts
                    ),
                    provenance={**project.provenance, "sourcePath": source},
                )
                atomic_write_text(manifest_path, encode_manifest(project))
                revision["fingerprint"] = manifest_fingerprint(project)

    def _relocate_json(self, row: LibraryRow, *, portable: bool) -> None:
        for field, value in row.items():
            if field.endswith("_json") and isinstance(value, str):
                row[field] = dumps(self._relocate(loads_value(value), portable=portable))

    def _relocate(self, value: object, *, portable: bool) -> object:
        if isinstance(value, dict):
            return {key: self._relocate(item, portable=portable) for key, item in value.items()}
        if isinstance(value, list):
            return [self._relocate(item, portable=portable) for item in value]
        if isinstance(value, str):
            if (
                portable
                and Path(value).is_absolute()
                and Path(value).is_relative_to(self._roots.app)
            ):
                return "library://" + Path(value).relative_to(self._roots.app).as_posix()
            if not portable and value.startswith("library://"):
                relative = portable_relative_path(value.removeprefix("library://"))
                if relative.parts[0] not in {"songs", "recordings"}:
                    raise ValueError("Invalid library reference")
                return str(ensure_within(self._roots.app / relative, self._roots.app))
        return value


def _identities(rows: list[LibraryRow], field: str) -> set[str]:
    ids = {portable_component(str(row[field])) for row in rows}
    if len(ids) != len(rows):
        raise ValueError("Duplicate library identities")
    return ids


def _validated_rows(data: dict[str, object]) -> LibraryRows:
    if set(data) != set(_TABLES):
        raise ValueError("Invalid library tables")
    result = {}
    for name, table in _TABLES.items():
        records = data[name]
        if not isinstance(records, list):
            raise ValueError("Invalid library rows")
        result[name] = [_validated_row(table, row) for row in records]
    return result


def _validated_row(table: Table, row: object) -> LibraryRow:
    columns = {column.name: column for column in table.columns if column.name != "id"}
    if not isinstance(row, dict) or set(row) != set(columns):
        raise ValueError("Invalid library row fields")
    result: LibraryRow = dict(row)
    for name, column in columns.items():
        value = result[name]
        if value is None:
            if not column.nullable:
                raise ValueError("Missing library value")
        elif isinstance(column.type, DateTime):
            if not isinstance(value, str):
                raise ValueError("Invalid library date")
            result[name] = datetime.fromisoformat(value)
        elif isinstance(column.type, Float):
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError("Invalid library number")
        elif not isinstance(value, column.type.python_type):
            raise ValueError("Invalid library value type")
    return result
