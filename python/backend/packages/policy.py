from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class PackagePolicy:
    max_files: int = 256
    max_uncompressed_bytes: int = 4 * 1024 * 1024 * 1024
    max_single_file_bytes: int = 2 * 1024 * 1024 * 1024
    max_compression_ratio: float = 200.0
