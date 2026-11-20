from __future__ import annotations

import hashlib
import logging
import os
from collections import OrderedDict
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock

from backend.projects.content_lock import KeyedLockManager
from backend.serialization import JsonValue, dumps, loads_value
from backend.songs.ports import FileHasher

_MEMORY_ENTRIES = 256
_BUCKET_ENTRIES = 64
_MAX_BUCKET_BYTES = 64 * 1024
logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class _Entry:
    identity: tuple[int, ...]
    digest: str


class FileHashCache:
    """Metadata-validated clip hashes for library queries, never integrity validation.

    A small memory LRU sits over 256 bounded disk buckets. Browsing a library larger
    than the LRU or reopening it reads small cache records instead of whole videos.
    """

    def __init__(self, root: Path, hasher: FileHasher) -> None:
        self._root = root
        self._hasher = hasher
        self._memory: OrderedDict[str, _Entry] = OrderedDict()
        self._guard = Lock()
        self._files = KeyedLockManager()
        self._buckets = KeyedLockManager()

    def __call__(self, path: Path) -> str:
        key = hashlib.sha256(str(path.absolute()).encode("utf-8")).hexdigest()
        with self._files.acquire(key):
            identity = _identity(path)
            cached = self._cached(key, identity)
            if cached is not None:
                return cached
            digest = self._hasher(path)
            # Never retain a checksum computed across an in-place edit or replacement.
            if identity == _identity(path):
                entry = _Entry(identity, digest)
                self._remember(key, entry)
                self._persist(key, entry)
            return digest

    def _cached(self, key: str, identity: tuple[int, ...]) -> str | None:
        with self._guard:
            entry = self._memory.get(key)
            if entry is not None and entry.identity == identity:
                self._memory.move_to_end(key)
                return entry.digest
        entry = _read_bucket(self._bucket(key)).get(key)
        if entry is None or entry.identity != identity:
            return None
        self._remember(key, entry)
        return entry.digest

    def _remember(self, key: str, entry: _Entry) -> None:
        with self._guard:
            self._memory[key] = entry
            self._memory.move_to_end(key)
            if len(self._memory) > _MEMORY_ENTRIES:
                self._memory.popitem(last=False)

    def _persist(self, key: str, entry: _Entry) -> None:
        try:
            with self._buckets.acquire(key[:2]):
                path = self._bucket(key)
                entries = _read_bucket(path)
                entries.pop(key, None)
                entries[key] = entry
                while len(entries) > _BUCKET_ENTRIES:
                    del entries[next(iter(entries))]
                _write_bucket(path, dumps({"version": 1, "entries": entries}))
        except OSError:
            # This is disposable acceleration; a read-only/full cache must not hide a song.
            logger.debug("Clip checksum cache could not be saved", exc_info=True)

    def _bucket(self, key: str) -> Path:
        return self._root / f"{key[:2]}.json"


def _identity(path: Path) -> tuple[int, ...]:
    info = path.stat()
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _write_bucket(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with NamedTemporaryFile(
            mode="wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(text.encode("utf-8"))
        # Close before publication, including on Windows. This disposable cache does
        # not need fsync: a lost entry is a cache miss, never lost canonical data.
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            with suppress(OSError):
                temporary.unlink(missing_ok=True)


def _read_bucket(path: Path) -> dict[str, _Entry]:
    try:
        with path.open("rb") as stream:
            raw = stream.read(_MAX_BUCKET_BYTES + 1)
        if len(raw) > _MAX_BUCKET_BYTES:
            return {}
        data = loads_value(raw)
        if not isinstance(data, dict) or data.get("version") != 1:
            return {}
        values = data.get("entries")
        if not isinstance(values, dict) or len(values) > _BUCKET_ENTRIES:
            return {}
        return {
            key: entry
            for key, value in values.items()
            if _digest(key) and (entry := _decode_entry(value)) is not None
        }
    except (OSError, ValueError):
        return {}


def _decode_entry(value: JsonValue) -> _Entry | None:
    if not isinstance(value, dict):
        return None
    identity, digest = value.get("identity"), value.get("digest")
    if not isinstance(identity, list) or len(identity) != 5:
        return None
    if any(type(part) is not int for part in identity) or not _digest(digest):
        return None
    return _Entry(tuple(part for part in identity if isinstance(part, int)), str(digest))


def _digest(value: JsonValue) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )
