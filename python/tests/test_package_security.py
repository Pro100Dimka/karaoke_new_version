from __future__ import annotations

from pathlib import PurePosixPath
import json

import pytest

from backend.domain_errors import DomainError
from backend.packages.policy import PackagePolicy
from backend.packages.ports import ArchiveEntry
from backend.packages.security import PackageSecurityValidator
from backend.packages.codec import decode_manifest


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


@pytest.mark.parametrize(
    "path",
    [
        "C:escape.wav",
        "nested/C:escape.wav",
        "audio.wav:payload",
        "CON",
        "aux.wav",
        "nested/NUL.txt",
        "audio.wav.",
        "audio.wav ",
        "nested\\..\\escape.wav",
    ],
)
def test_windows_archive_aliases_and_drive_relative_paths_are_rejected(path: str) -> None:
    with pytest.raises(DomainError) as raised:
        PackageSecurityValidator(PackagePolicy()).validate((entry(path),))
    assert raised.value.code == "PackageInvalid"


@pytest.mark.parametrize(
    "paths",
    [
        ("audio.wav", "audio.wav"),
        ("audio.wav", "AUDIO.WAV"),
        ("nested/audio.wav", "nested\\audio.wav"),
        ("nested", "nested/audio.wav"),
    ],
)
def test_archive_entries_cannot_overwrite_or_alias_each_other(paths: tuple[str, str]) -> None:
    with pytest.raises(DomainError) as raised:
        PackageSecurityValidator(PackagePolicy()).validate(tuple(entry(path) for path in paths))
    assert raised.value.code == "PackageInvalid"


@pytest.mark.parametrize(
    "field,value",
    [
        ("songId", "../outside"),
        ("songId", "C:outside"),
        ("songId", "."),
        ("songId", "NUL"),
        ("songId", "nested/song"),
        ("songId", "song."),
        ("artifact", "../outside"),
        ("artifact", "C:outside"),
        ("artifact", "audio.wav:stream"),
        ("revision", True),
        ("revision", -1),
    ],
)
def test_package_manifest_rejects_unsafe_identity_and_artifacts(field: str, value: object) -> None:
    song = {
        "songId": "song-1",
        "sourceIdentity": "source-1",
        "title": "Title",
        "artist": "Artist",
        "language": "Auto",
        "duration": 1.0,
    }
    manifest = {
        "packageVersion": 1,
        "projectFormatVersion": 1,
        "songIdentity": song,
        "revision": 1,
        "revisionFingerprint": "fingerprint",
        "lineageId": "lineage",
        "artifacts": [{"path": "audio.wav", "checksum": "checksum"}],
    }
    if field == "songId":
        song[field] = value
    elif field == "artifact":
        manifest["artifacts"] = [{"path": value, "checksum": "checksum"}]
    else:
        manifest[field] = value
    with pytest.raises(ValueError):
        decode_manifest(json.dumps(manifest))
