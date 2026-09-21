from __future__ import annotations

from pathlib import PurePosixPath
from typing import Sequence

from backend.domain_errors import DomainError
from backend.packages.policy import PackagePolicy
from backend.packages.ports import ArchiveEntry


class PackageSecurityValidator:
    def __init__(self, policy: PackagePolicy) -> None:
        self._policy = policy

    def validate(self, entries: Sequence[ArchiveEntry]) -> None:
        if len(entries) > self._policy.max_files:
            raise DomainError("PackageInvalid", "Package contains too many files", 400)
        total = 0
        for entry in entries:
            self._validate_entry(entry)
            total += entry.file_size
            if total > self._policy.max_uncompressed_bytes:
                raise DomainError("PackageInvalid", "Package is too large when extracted", 400)

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
    drive_like = bool(path.parts and path.parts[0].endswith(":"))
    return path.is_absolute() or drive_like or ".." in path.parts or not path.parts
