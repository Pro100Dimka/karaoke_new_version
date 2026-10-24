from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Mapping, Protocol, Sequence


@dataclass(frozen=True, slots=True)
class ArchiveEntry:
    path: PurePosixPath
    file_size: int
    compressed_size: int
    is_symlink: bool


class PackageArchive(Protocol):
    def inspect(self, archive: Path) -> Sequence[ArchiveEntry]: ...

    def read_text(self, archive: Path, path: PurePosixPath, *, max_bytes: int) -> str: ...

    def extract(
        self, archive: Path, destination: Path, progress: Callable[[float], None] | None = None
    ) -> None: ...

    def build(
        self,
        destination: Path,
        files: Mapping[PurePosixPath, Path],
        texts: Mapping[PurePosixPath, str],
        progress: Callable[[float], None] | None = None,
    ) -> None: ...


class PackageOutputStorage(Protocol):
    def path_for_export(self, song_id: str, revision: int) -> Path: ...


class LibraryStorage(Protocol):
    def export_path(self, job_id: str) -> Path: ...

    def require_free(self, required_bytes: int) -> None: ...

    def song_ids(self) -> tuple[str, ...]: ...

    def snapshot(
        self, song_ids: Sequence[str]
    ) -> tuple[dict[str, object], Mapping[PurePosixPath, Path]]: ...

    def restore(self, data: dict[str, object], workspace: Path) -> dict[str, int]: ...
