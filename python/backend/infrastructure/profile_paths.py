from __future__ import annotations
import hashlib
import os
import shutil
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from types import MappingProxyType
from dotenv import dotenv_values, set_key
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.hashing import sha256_file
from backend.serialization import dumps, loads_object
from backend.storage.path_policy import portable_component


_DATA_NAMES = frozenset(
    {
        "songs",
        "models",
        "cache",
        "recordings",
        "temp",
        "quarantine",
        "logs",
        "recovery",
        "environment",
        "backups",
        "exports",
        ".ad-voice-data",
        "app.db",
        "app.db-wal",
        "app.db-shm",
        "backend.lock",
        "backend.lock.guard",
    }
)


_LOCK_FILES = frozenset({"backend.lock", "backend.lock.guard"})


_IMMUTABLE_MEDIA = frozenset(
    {
        ".wav",
        ".flac",
        ".mp3",
        ".m4a",
        ".ogg",
        ".mp4",
        ".webm",
        ".bin",
        ".pt",
        ".onnx",
        ".safetensors",
        ".zip",
        ".dll",
        ".pyd",
        ".exe",
        ".whl",
        ".pak",
    }
)


_FILE_FIELDS = MappingProxyType(
    {
        "songs": ("source_path", "cover_path"),
        "recordings": ("file_path",),
        "ai_models": ("local_path",),
    }
)


def _records(state: dict[str, object], key: str) -> list[dict[str, object]]:
    value = state.get(key)
    if not isinstance(value, list):
        raise ValueError(f"Invalid migration journal: {key}")
    result: list[dict[str, object]] = []
    for item in value:
        if not isinstance(item, dict) or any(not isinstance(field, str) for field in item):
            raise ValueError(f"Invalid migration journal entry: {key}")
        result.append(item)
    return result


def _path(item: dict[str, object], key: str) -> Path:
    value = item.get(key)
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ValueError(f"Invalid migration path: {key}")
    return Path(value)


def _relocate(value: object, mappings: dict[Path, Path]) -> object:
    if isinstance(value, dict):
        return {key: _relocate(item, mappings) for key, item in value.items()}
    if isinstance(value, list):
        return [_relocate(item, mappings) for item in value]
    if isinstance(value, str) and Path(value).is_absolute():
        for source, target in sorted(
            mappings.items(), key=lambda item: len(item[0].parts), reverse=True
        ):
            for candidate in (Path(value), Path(value).resolve()):
                if candidate.is_relative_to(source):
                    return str(target / candidate.relative_to(source))
    return value


def _files(
    source: Path, mappings: dict[Path, Path], ignored: set[Path] | None = None
) -> list[Path]:
    ignored = ignored or set()
    _check_entry(source)
    if not source.exists():
        return []
    if source.is_file():
        return [source]
    files: list[Path] = []
    pending = [source]
    while pending:
        for file in pending.pop().iterdir():
            if file in mappings or file in ignored:
                continue
            _check_entry(file)
            if file.is_dir():
                pending.append(file)
            elif file.is_file():
                files.append(file)
            else:
                raise ValueError(f"Legacy entry is unreadable: {file}")
    return files


def _copy(
    source: Path,
    target: Path,
    links: dict[tuple[int, int], Path],
    temporary_dir: Path,
    expected: str | None = None,
    *,
    owned: bool = False,
) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    info = source.stat()
    identity = (info.st_dev, info.st_ino)
    shared = source.suffix.casefold() in _IMMUTABLE_MEDIA
    digest = sha256_file(source)
    if expected is not None and expected != digest:
        raise ValueError(f"Conflicting legacy files map to the same destination: {target}")
    if target.is_file() and sha256_file(target) == digest:
        if shared:
            links.setdefault(identity, target)
        return digest
    descriptor, raw = tempfile.mkstemp(prefix="storage-", dir=temporary_dir)
    os.close(descriptor)
    temporary = Path(raw)
    _copy_temporary(source, target, temporary, links, identity, info, digest, shared, owned)
    if source.stat().st_mtime_ns != info.st_mtime_ns or source.stat().st_size != info.st_size:
        temporary.unlink(missing_ok=True)
        raise ValueError(f"Source changed during migration: {source}")
    os.replace(temporary, target)
    if shared:
        links[identity] = target
    return digest


def _plans(profile: Path, target: Path) -> dict[Path, Path]:
    default = profile / "backend-data"
    saved = profile / "storage-root.txt"
    active = Path(saved.read_text(encoding="utf-8").strip()) if saved.is_file() else default
    if not active.is_absolute():
        raise ValueError("Legacy storage path must be absolute")
    if saved.is_file() and not active.is_dir():
        raise ValueError(f"Legacy library is unavailable: {active}")
    mappings = {profile: target, active.resolve(): target / "backend-data"}
    known = profile / "storage-roots.txt"
    roots = (
        [
            default,
            *(
                Path(line)
                for line in known.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ),
        ]
        if known.is_file()
        else [default]
    )
    for root in roots:
        if not root.is_absolute() or not root.is_dir() or root.resolve() in mappings:
            continue
        root = root.resolve()
        if root != default.resolve() and not (root / ".ad-voice-data").is_file():
            continue
        key = hashlib.sha256(str(root).casefold().encode()).hexdigest()[:16]
        mappings[root] = target / "legacy-data" / key
    models = default / "models"
    if models.is_dir() and models.resolve() != active.resolve() / "models":
        mappings[models.resolve()] = target / "backend-data" / "models"
    return mappings


def _external_sources(
    mappings: dict[Path, Path], target: Path, libraries: list[dict[str, object]]
) -> None:
    fields = {
        "songs": ("song_id", ("source_path", "cover_path")),
        "recordings": ("recording_id", ("file_path",)),
        "ai_models": ("model_id", ("local_path",)),
    }
    for item in libraries:
        source, destination = _path(item, "source"), _path(item, "target")
        database = source / "app.db"
        if not database.is_file():
            continue
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
            connection.row_factory = sqlite3.Row
            tables = {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            for table, (identity, paths) in fields.items():
                if table not in tables:
                    continue
                columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
                for row in connection.execute(f'SELECT * FROM "{table}"'):
                    for field in paths:
                        if field not in columns or not row[field]:
                            continue
                        _external_file(row, field, identity, table, target, destination, mappings)


def _rewrite_metadata(working: Path, mappings: dict[Path, Path]) -> None:
    for file in [
        *(working / "recovery").glob("*.json"),
        *(working / "recordings").glob("*/recording-recovery.json"),
    ]:
        original = loads_object(file.read_text(encoding="utf-8"))
        relocated = _relocate(original, mappings)
        if original != relocated:
            atomic_write_text(file, dumps(relocated))
    for file in (working / "environment").glob("*.env"):
        for key, value in dotenv_values(file).items():
            relocated = _relocate(value, mappings)
            if isinstance(relocated, str) and relocated != value:
                set_key(file, key, relocated, quote_mode="auto")


def _check_entry(path: Path) -> None:
    if path.is_symlink() or path.is_junction():
        raise ValueError(f"Linked entry needs review before migration: {path}")


def _copy_temporary(
    source: Path,
    target: Path,
    temporary: Path,
    links: dict[tuple[int, int], Path],
    identity: tuple[int, int],
    info: os.stat_result,
    digest: str,
    shared: bool,
    owned: bool,
) -> None:
    role = {part.casefold() for part in source.parts}
    source_link = (
        owned
        and shared
        and "recordings" not in role
        and bool(role & {"models", "gpu-runtime", "revisions"})
        and info.st_dev == target.parent.stat().st_dev
    )
    if shared and (identity in links or source_link):
        temporary.unlink()
        os.link(links.get(identity, source), temporary)
    else:
        shutil.copy2(source, temporary)
        if sha256_file(temporary) != digest:
            raise ValueError(f"Migration checksum failed: {source}")


def _external_file(
    row: sqlite3.Row,
    field: str,
    identity: str,
    table: str,
    target: Path,
    destination: Path,
    mappings: dict[Path, Path],
) -> None:
    file = Path(row[field]).resolve()
    if file.exists() and not file.is_file():
        raise ValueError(f"Registered media is not a regular file: {file}")
    location = _external_location(row, field, identity, table, target, destination, file)
    relocated = _relocate(str(file), mappings)
    if any(file.is_relative_to(root) for root in mappings) and (
        table != "ai_models" or relocated == str(location)
    ):
        return
    mappings[file] = location
    if table == "recordings" and file.is_file():
        for companion in file.parent.glob(file.stem + "*"):
            if companion.is_file():
                mappings[companion.resolve()] = location.parent / companion.name


def _external_location(
    row: sqlite3.Row,
    field: str,
    identity: str,
    table: str,
    target: Path,
    destination: Path,
    file: Path,
) -> Path:
    group = portable_component(str(row[identity]))
    if table == "ai_models":
        location = (
            target
            / "backend-data"
            / "models"
            / group
            / portable_component(str(row["version"]))
            / "model.bin"
        )
    else:
        category = "source" if field == "source_path" else "cover"
        location = destination / ("recordings" if table == "recordings" else "songs") / group
        if table == "songs":
            location /= category
        location /= file.name
    return location
