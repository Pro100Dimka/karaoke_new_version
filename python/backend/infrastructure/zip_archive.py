from __future__ import annotations

import os
import shutil
import tempfile
import stat
import zipfile
from pathlib import Path, PurePosixPath
from typing import Callable, Mapping, Sequence

from backend.domain_errors import DependencyError, DomainError
from backend.packages.policy import PackagePolicy
from backend.packages.ports import ArchiveEntry
from backend.storage.path_policy import portable_relative_path
from backend.infrastructure.paths import ensure_within


class ZipPackageArchive:
    def __init__(self, policy: PackagePolicy = PackagePolicy()) -> None:
        self._policy = policy

    def inspect(self, archive: Path) -> Sequence[ArchiveEntry]:
        try:
            with zipfile.ZipFile(archive, "r") as bundle:
                return tuple(_entry(info) for info in bundle.infolist() if not info.is_dir())
        except (OSError, zipfile.BadZipFile) as exc:
            raise DomainError("PackageInvalid", "Package archive is corrupt", 400) from exc

    def read_text(self, archive: Path, path: PurePosixPath, *, max_bytes: int) -> str:
        try:
            with zipfile.ZipFile(archive, "r") as bundle:
                info = bundle.getinfo(path.as_posix())
                if info.file_size > max_bytes:
                    raise DomainError("PackageInvalid", "Package manifest exceeds size limit", 400)
                raw = bundle.read(info)
            return raw.decode("utf-8")
        except KeyError as exc:
            raise DomainError("PackageInvalid", "Package manifest is missing", 400) from exc
        except UnicodeDecodeError as exc:
            raise DomainError("PackageInvalid", "Package manifest is not UTF-8", 400) from exc
        except (OSError, zipfile.BadZipFile) as exc:
            raise DomainError("PackageInvalid", "Package archive cannot be read", 400) from exc

    def extract(
        self, archive: Path, destination: Path, progress: Callable[[float], None] | None = None
    ) -> None:
        destination.mkdir(parents=True, exist_ok=True)
        try:
            with zipfile.ZipFile(archive, "r") as bundle:
                total = sum(info.file_size for info in bundle.infolist()) or 1
                completed = 0
                for info in bundle.infolist():
                    if info.is_dir():
                        continue
                    relative = _normalized(info.filename)
                    _require_safe(relative, info)
                    target = ensure_within(destination.joinpath(*relative.parts), destination)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(info, "r") as source, target.open("wb") as output:
                        if progress is None:
                            shutil.copyfileobj(source, output, length=1024 * 1024)
                        else:
                            while chunk := source.read(1024 * 1024):
                                output.write(chunk)
                                completed += len(chunk)
                                progress(completed / total)
        except (OSError, zipfile.BadZipFile) as exc:
            raise DependencyError("PackageInvalid", "Package extraction failed") from exc

    def build(
        self,
        destination: Path,
        files: Mapping[PurePosixPath, Path],
        texts: Mapping[PurePosixPath, str],
        progress: Callable[[float], None] | None = None,
    ) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = _temporary_archive(destination)
        try:
            _write_archive(temporary, files, texts, progress=progress)
            with zipfile.ZipFile(temporary) as bundle:
                stored = {
                    PurePosixPath(info.filename): zipfile.ZIP_STORED
                    for info in bundle.infolist()
                    if info.file_size > info.compress_size * self._policy.max_compression_ratio
                }
            if stored:
                # Repetitive audio (including silence) must remain importable without
                # weakening the archive-bomb limit or buffering whole media files.
                _write_archive(temporary, files, texts, stored, progress)
            _validate_built_archive(temporary)
            os.replace(temporary, destination)
        except (OSError, zipfile.BadZipFile) as exc:
            temporary.unlink(missing_ok=True)
            raise DependencyError(
                "PackageExportFailed", "Package archive could not be built"
            ) from exc
        finally:
            temporary.unlink(missing_ok=True)


def _entry(info: zipfile.ZipInfo) -> ArchiveEntry:
    mode = (info.external_attr >> 16) & 0xFFFF
    return ArchiveEntry(
        path=_normalized(info.filename),
        file_size=info.file_size,
        compressed_size=info.compress_size,
        is_symlink=stat.S_ISLNK(mode),
    )


def _normalized(name: str) -> PurePosixPath:
    return PurePosixPath(name.replace("\\", "/"))


def _require_safe(path: PurePosixPath, info: zipfile.ZipInfo) -> None:
    try:
        portable_relative_path(path.as_posix())
    except ValueError as exc:
        raise DomainError("PackageInvalid", "Archive contains an unsafe path", 400) from exc
    mode = (info.external_attr >> 16) & 0xFFFF
    if stat.S_ISLNK(mode):
        raise DomainError("PackageInvalid", "Archive contains an unsafe path", 400)


def _temporary_archive(destination: Path) -> Path:
    descriptor, raw = tempfile.mkstemp(
        prefix=f".{destination.name}-", suffix=".tmp", dir=destination.parent
    )
    os.close(descriptor)
    return Path(raw)


def _write_archive(
    destination: Path,
    files: Mapping[PurePosixPath, Path],
    texts: Mapping[PurePosixPath, str],
    compression: Mapping[PurePosixPath, int] | None = None,
    progress: Callable[[float], None] | None = None,
) -> None:
    compression = compression or {}
    total = sum(source.stat().st_size for source in files.values()) or 1
    completed = 0
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for path, source in files.items():
            if progress is None:
                bundle.write(source, path.as_posix(), compress_type=compression.get(path))
            else:
                info = zipfile.ZipInfo.from_file(source, path.as_posix())
                info.compress_type = compression.get(path, zipfile.ZIP_DEFLATED)
                with (
                    source.open("rb") as stream,
                    bundle.open(info, "w", force_zip64=True) as output,
                ):
                    while chunk := stream.read(1024 * 1024):
                        output.write(chunk)
                        completed += len(chunk)
                        progress(completed / total)
        for path, text in texts.items():
            bundle.writestr(
                path.as_posix(), text.encode("utf-8"), compress_type=compression.get(path)
            )
    with destination.open("r+b") as stream:
        os.fsync(stream.fileno())


def _validate_built_archive(path: Path) -> None:
    with zipfile.ZipFile(path, "r") as bundle:
        if bundle.testzip() is not None:
            raise zipfile.BadZipFile("archive checksum validation failed")
