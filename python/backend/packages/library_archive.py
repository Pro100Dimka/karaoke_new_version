from __future__ import annotations

from contextlib import ExitStack
from pathlib import Path, PurePosixPath
from typing import Callable, Literal

from backend.domain_errors import DomainError
from backend.packages.ports import LibraryStorage, PackageArchive
from backend.packages.security import PackageSecurityValidator
from backend.processing.domain import Job, JobType
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.projects.operations import SongOperation, SongOperationRegistry
from backend.serialization import dumps, loads_object
from backend.songs.ports import FileHasher
from backend.storage.ports import WorkStorage
from backend.version import DB_SCHEMA_VERSION


class LibraryArchive:
    def __init__(
        self,
        jobs: ProcessingJobManager,
        library: LibraryStorage,
        archive: PackageArchive,
        security: PackageSecurityValidator,
        workspaces: WorkStorage,
        operations: SongOperationRegistry,
        hasher: FileHasher,
    ) -> None:
        self._jobs, self._library, self._archive = jobs, library, archive
        self._security, self._workspaces = security, workspaces
        self._operations, self._hasher = operations, hasher

    def start(self, action: Literal["export", "import"], path: Path | None = None) -> Job:
        return self._jobs.start(
            {"export": JobType.PACKAGE_EXPORT, "import": JobType.PACKAGE_IMPORT}[action],
            lambda context: self._run(action, path, context),
            entity_id="library",
        )

    def _run(self, action: str, path: Path | None, context: JobContext) -> dict[str, object]:
        workspace = self._workspaces.allocate("library")
        try:
            if action == "export":
                return self._export(context)
            assert path is not None
            return self._import(path, workspace, context)
        finally:
            self._workspaces.cleanup(workspace)

    def _export(self, context: JobContext) -> dict[str, object]:
        with ExitStack() as locks:
            song_ids = self._library.song_ids()
            for song_id in song_ids:
                locks.enter_context(self._operations.acquire(song_id, SongOperation.PACKAGE_EXPORT))
            data, files = self._library.snapshot(song_ids)
            self._library.require_free(sum(p.stat().st_size for p in files.values()))
            checksums = {}
            progress = _progress(context, "Snapshot", 0, 0.15)
            for index, (name, source) in enumerate(files.items()):
                checksums[name.as_posix()] = self._hasher.hash_file(source)
                progress((index + 1) / max(1, len(files)))
            manifest = {
                "version": 1,
                "schemaVersion": DB_SCHEMA_VERSION,
                "data": data,
                "files": checksums,
            }
            output = self._library.export_path(context.job_id)
            self._archive.build(
                output,
                files,
                {PurePosixPath("library.json"): dumps(manifest)},
                _progress(context, "Archive", 0.15, 0.8),
            )
            context.progress("Archive", 1, 1)
            return {"path": str(output)}

    def _import(self, path: Path, workspace: Path, context: JobContext) -> dict[str, object]:
        entries = self._archive.inspect(path)
        self._security.validate(entries)
        self._library.require_free(sum(entry.file_size for entry in entries))
        try:
            manifest = loads_object(
                self._archive.read_text(
                    path, PurePosixPath("library.json"), max_bytes=64 * 1024 * 1024
                )
            )
            if manifest.get("version") != 1 or manifest.get("schemaVersion") != DB_SCHEMA_VERSION:
                raise ValueError("Unsupported library archive version")
            data, files = manifest["data"], manifest["files"]
            if not isinstance(data, dict) or not isinstance(files, dict):
                raise ValueError("Invalid library manifest")
            if {entry.path.as_posix() for entry in entries} != {*files, "library.json"}:
                raise ValueError("Library archive files do not match its manifest")
            self._archive.extract(path, workspace, _progress(context, "Extract", 0, 0.8))
            progress = _progress(context, "Verify", 0.8, 0.15)
            for index, (name, checksum) in enumerate(files.items()):
                if self._hasher.hash_file(workspace / name) != checksum:
                    raise ValueError("Library file checksum failed")
                progress((index + 1) / max(1, len(files)))
            context.ensure_not_cancelled()
            with ExitStack() as locks:
                for song in data.get("songs", []):
                    locks.enter_context(
                        self._operations.acquire(song["song_id"], SongOperation.PACKAGE_IMPORT)
                    )
                result = self._library.restore(data, workspace)
            context.progress("Publish", 1, 1)
            return dict(result)
        except (ValueError, KeyError, TypeError) as exc:
            raise DomainError("PackageInvalid", "Library archive is invalid", 400) from exc


def _progress(
    context: JobContext, stage: str, start: float, weight: float
) -> Callable[[float], None]:
    last = -1

    def update(value: float) -> None:
        nonlocal last
        context.ensure_not_cancelled()
        percent = int(value * 100)
        if percent > last:
            last = percent
            context.progress(stage, value, start + weight * value)

    return update
