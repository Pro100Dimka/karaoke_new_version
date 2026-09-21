from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Mapping, Protocol, Sequence


@dataclass(frozen=True, slots=True)
class ArchiveEntry:
    path: PurePosixPath
    file_size: int
    compressed_size: int
    is_symlink: bool


class PackageArchive(Protocol):
    def inspect(self, archive: Path) -> Sequence[ArchiveEntry]: ...

    def read_text(self, archive: Path, path: PurePosixPath, *, max_bytes: int) -> str: ...

    def extract(self, archive: Path, destination: Path) -> None: ...

    def build(
        self,
        destination: Path,
        files: Mapping[PurePosixPath, Path],
        texts: Mapping[PurePosixPath, str],
    ) -> None: ...


class PackageOutputStorage(Protocol):
    def path_for_export(self, song_id: str, revision: int) -> Path: ...
