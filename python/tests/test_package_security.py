from __future__ import annotations

from pathlib import PurePosixPath

import pytest

from backend.domain_errors import DomainError
from backend.packages.policy import PackagePolicy
from backend.packages.ports import ArchiveEntry
from backend.packages.security import PackageSecurityValidator


def entry(
    path: str,
    *,
    size: int = 10,
    compressed: int = 10,
    symlink: bool = False,
) -> ArchiveEntry:
    return ArchiveEntry(PurePosixPath(path), size, compressed, symlink)


@pytest.mark.parametrize("path", ["../evil", "/absolute/file", "C:/drive/file", "a/../../evil"])
def test_unsafe_archive_paths_are_rejected(path: str) -> None:
    validator = PackageSecurityValidator(PackagePolicy())

    with pytest.raises(DomainError) as error:
        validator.validate((entry(path),))

    assert error.value.code == "PackageInvalid"


def test_symlink_is_rejected() -> None:
    with pytest.raises(DomainError, match="symlink"):
        PackageSecurityValidator(PackagePolicy()).validate((entry("link", symlink=True),))


def test_too_many_files_are_rejected() -> None:
    policy = PackagePolicy(max_files=1)

    with pytest.raises(DomainError, match="too many"):
        PackageSecurityValidator(policy).validate((entry("a"), entry("b")))


def test_oversized_single_file_is_rejected() -> None:
    policy = PackagePolicy(max_single_file_bytes=9)

    with pytest.raises(DomainError, match="oversized"):
        PackageSecurityValidator(policy).validate((entry("a", size=10),))


def test_total_uncompressed_size_is_bounded() -> None:
    policy = PackagePolicy(max_uncompressed_bytes=15)

    with pytest.raises(DomainError, match="too large"):
        PackageSecurityValidator(policy).validate((entry("a", size=10), entry("b", size=10)))


def test_suspicious_compression_ratio_is_rejected() -> None:
    policy = PackagePolicy(max_compression_ratio=10)

    with pytest.raises(DomainError, match="compression ratio"):
        PackageSecurityValidator(policy).validate((entry("bomb", size=1_000, compressed=1),))
