from __future__ import annotations

from pathlib import PurePosixPath
from typing import Sequence

from backend.domain_errors import DomainError
from backend.packages.policy import PackagePolicy
from backend.packages.ports import ArchiveEntry
from backend.storage.path_policy import portable_relative_path


class PackageSecurityValidator:
    def __init__(self, policy: PackagePolicy) -> None:
        self._policy = policy

    def validate(self, entries: Sequence[ArchiveEntry]) -> None:
        if len(entries) > self._policy.max_files:
            raise DomainError("PackageInvalid", "Package contains too many files", 400)
        total = 0
        paths: set[PurePosixPath] = set()
        for entry in entries:
            self._validate_entry(entry)
            path = portable_relative_path(entry.path.as_posix().casefold())
            if path in paths:
                raise DomainError("PackageInvalid", "Package contains duplicate paths", 400)
            paths.add(path)
            total += entry.file_size
            if total > self._policy.max_uncompressed_bytes:
                raise DomainError("PackageInvalid", "Package is too large when extracted", 400)
        if any(parent in paths for path in paths for parent in path.parents):
            raise DomainError("PackageInvalid", "Package file conflicts with a directory", 400)

    def _validate_entry(self, entry: ArchiveEntry) -> None:
        path = entry.path
        if _unsafe(path):
            raise DomainError("PackageInvalid", "Package contains an unsafe path", 400)
        if entry.is_symlink:
            raise DomainError("PackageInvalid", "Package contains an unsafe symlink", 400)
        if entry.file_size > self._policy.max_single_file_bytes:
            raise DomainError("PackageInvalid", "Package contains an oversized file", 400)
        if entry.compressed_size == 0 and entry.file_size > 0:
            raise DomainError(
                "PackageInvalid", "Package contains suspicious compression metadata", 400
            )
        if entry.compressed_size > 0:
            ratio = entry.file_size / entry.compressed_size
            if ratio > self._policy.max_compression_ratio:
                raise DomainError("PackageInvalid", "Package compression ratio exceeds policy", 400)


def _unsafe(path: PurePosixPath) -> bool:
    try:
        portable_relative_path(path.as_posix())
    except ValueError:
        return True
    return False
