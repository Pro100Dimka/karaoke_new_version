from __future__ import annotations

import logging
import os
import shutil
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from tempfile import NamedTemporaryFile

from backend.domain_errors import DependencyError
from backend.projects.content_lock import KeyedLockManager
from backend.songs.ports import SongMediaUpdate

logger = logging.getLogger(__name__)
FileIdentity = tuple[int, int, int, int]
PublicationObserver = Callable[[Path, FileIdentity], None]
CopyMedia = Callable[[str, Path], Path]


def _identity(path: Path) -> FileIdentity | None:
    try:
        status = path.stat()
    except FileNotFoundError:
        return None
    return status.st_dev, status.st_ino, status.st_size, status.st_mtime_ns


class SongMediaUpdates:
    def __init__(self, root: Path) -> None:
        self._root = root
        self._locks = KeyedLockManager()
        self._observer: ContextVar[PublicationObserver | None] = ContextVar(
            "song_media_publication", default=None
        )

    @contextmanager
    def open(
        self, song_id: str, copy_cover: CopyMedia, copy_clip: CopyMedia
    ) -> Iterator[SongMediaUpdate]:
        with self._locks.acquire(song_id):
            update = _MediaUpdate(
                song_id, self._root / song_id, copy_cover, copy_clip, self._observer
            )
            try:
                yield update
            finally:
                update.close()

    def publish(self, temporary: Path, target: Path) -> None:
        observer = self._observer.get()
        identity = _identity(temporary) if observer is not None else None
        os.replace(temporary, target)
        if observer is not None and identity is not None:
            observer(target, identity)


class _MediaUpdate:
    def __init__(
        self,
        song_id: str,
        root: Path,
        copy_cover: CopyMedia,
        copy_clip: CopyMedia,
        observer: ContextVar[PublicationObserver | None],
    ) -> None:
        self._song_id = song_id
        self._root = root
        self._copy_cover = copy_cover
        self._copy_clip = copy_clip
        self._observer = observer
        self._backups: dict[Path, Path | None] = {}
        self._published: dict[Path, FileIdentity] = {}
        self._committed = False

    def copy_cover(self, source: Path) -> Path:
        return self._copy(source, self._root / "cover" / source.name, self._copy_cover)

    def copy_clip(self, source: Path) -> Path:
        return self._copy(source, self._root / "media" / "clip.mp4", self._copy_clip)

    def commit(self) -> None:
        self._committed = True

    def _copy(self, source: Path, target: Path, copy: CopyMedia) -> Path:
        if source.resolve() == target.resolve():
            return copy(self._song_id, source)
        self._backup(target)

        def published(path: Path, identity: FileIdentity) -> None:
            if path == target:
                self._published[path] = identity

        token = self._observer.set(published)
        try:
            return copy(self._song_id, source)
        finally:
            self._observer.reset(token)

    def _backup(self, target: Path) -> None:
        if target in self._backups:
            return
        self._backups[target] = None
        try:
            if target.exists():
                with NamedTemporaryFile(
                    dir=target.parent, prefix=f".{target.name}.", suffix=".backup", delete=False
                ) as output:
                    self._backups[target] = Path(output.name)
                    with target.open("rb") as source:
                        shutil.copyfileobj(source, output)
                    output.flush()
                    os.fsync(output.fileno())
        except OSError as exc:
            raise DependencyError("StorageUnavailable", "Could not preserve song media") from exc

    def close(self) -> None:
        retained: set[Path] = set()
        if not self._committed:
            for target, identity in reversed(self._published.items()):
                self._restore(target, identity, retained)
        for backup in self._backups.values():
            if backup is not None and backup not in retained:
                try:
                    backup.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove media backup: %s", backup, exc_info=True)

    def _restore(self, target: Path, identity: FileIdentity, retained: set[Path]) -> None:
        backup = self._backups[target]
        try:
            # A publisher outside this manual edit may have installed a newer file.
            if _identity(target) != identity:
                return
            if backup is None:
                target.unlink(missing_ok=True)
            else:
                os.replace(backup, target)
        except OSError:
            if backup is not None:
                retained.add(backup)
            logger.error(
                "Could not restore song media from %s to %s", backup, target, exc_info=True
            )
