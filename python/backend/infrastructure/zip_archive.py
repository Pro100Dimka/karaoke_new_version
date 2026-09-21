from __future__ import annotations

import os
import shutil
import tempfile
import stat
import zipfile
from pathlib import Path, PurePosixPath
from typing import Mapping, Sequence

from backend.domain_errors import DependencyError, DomainError
from backend.packages.ports import ArchiveEntry


class ZipPackageArchive:
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

    def extract(self, archive: Path, destination: Path) -> None:
        destination.mkdir(parents=True, exist_ok=True)
        try:
            with zipfile.ZipFile(archive, "r") as bundle:
                for info in bundle.infolist():
                    if info.is_dir():
                        continue
                    relative = _normalized(info.filename)
                    _require_safe(relative, info)
                    target = destination.joinpath(*relative.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(info, "r") as source, target.open("wb") as output:
                        shutil.copyfileobj(source, output, length=1024 * 1024)
        except (OSError, zipfile.BadZipFile) as exc:
            raise DependencyError("PackageInvalid", "Package extraction failed") from exc

    def build(
        self,
        destination: Path,
        files: Mapping[PurePosixPath, Path],
        texts: Mapping[PurePosixPath, str],
    ) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = _temporary_archive(destination)
        try:
            _write_archive(temporary, files, texts)
            _validate_built_archive(temporary)
            os.replace(temporary, destination)
        except (OSError, zipfile.BadZipFile) as exc:
            temporary.unlink(missing_ok=True)
            raise DependencyError(
                "PackageExportFailed", "Package archive could not be built"
            ) from exc


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
    drive_like = bool(path.parts and path.parts[0].endswith(":"))
    mode = (info.external_attr >> 16) & 0xFFFF
    if path.is_absolute() or drive_like or ".." in path.parts or stat.S_ISLNK(mode):
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
) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for path, source in files.items():
            bundle.write(source, path.as_posix())
        for path, text in texts.items():
            bundle.writestr(path.as_posix(), text.encode("utf-8"))
    with destination.open("r+b") as stream:
        os.fsync(stream.fileno())


def _validate_built_archive(path: Path) -> None:
    with zipfile.ZipFile(path, "r") as bundle:
        if bundle.testzip() is not None:
            raise zipfile.BadZipFile("archive checksum validation failed")
