from __future__ import annotations

from dataclasses import replace
from collections.abc import Callable
from pathlib import Path
from threading import Event
from typing import Protocol

from backend.domain_errors import NotFoundError
from backend.persistence import UnitOfWorkFactory
from backend.processing.ports import ConcurrentRunner
from backend.projects.content_lock import KeyedLockManager
from backend.runtime import Clock
from backend.songs.domain import Song
from backend.songs.refresh_recognition import RefreshSongRecognition

LOCAL_CLIP = "local:clip"


class ClipDownloader(Protocol):
    def download(
        self,
        source_url: str,
        destination: Path,
        *,
        expected_duration: float | None,
        cancel: Event | None = None,
    ) -> bool: ...


def clip_path(song: Song) -> Path | None:
    if song.source_path is None:
        return None
    return song.source_path.parent.parent / "media" / "clip.mp4"


class PrepareSongClip:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        downloader: ClipDownloader,
        clock: Clock,
        locks: KeyedLockManager,
    ) -> None:
        self._uow = uow
        self._downloader = downloader
        self._clock = clock
        self._locks = locks

    def execute(self, song: Song, cancel: Event | None = None) -> Song:
        destination = clip_path(song)
        if destination is None:
            return song
        if destination.is_file():
            return self._save(song, LOCAL_CLIP) if song.video_url != LOCAL_CLIP else song
        source_url = song.video_url or ""
        if not source_url:
            return song
        ready = self._downloader.download(
            source_url, destination, expected_duration=song.duration, cancel=cancel
        )
        if cancel is not None and cancel.is_set():
            return song
        return self._save(song, LOCAL_CLIP) if ready else song

    def _save(self, song: Song, video_url: str | None) -> Song:
        with self._locks.acquire(song.song_id), self._uow.create() as transaction:
            current = transaction.songs.get(song.song_id)
            if current is None:
                raise NotFoundError("SongNotFound", "Song was not found", songId=song.song_id)
            updated = replace(current, video_url=video_url, updated_at=self._clock.now())
            transaction.songs.update(updated)
            transaction.commit()
        return updated


class PrepareSong:
    def __init__(
        self,
        recognition: RefreshSongRecognition,
        clip: PrepareSongClip,
        concurrency: ConcurrentRunner,
    ) -> None:
        self._recognition = recognition
        self._clip = clip
        self._concurrency = concurrency

    def execute(self, song: Song) -> Song:
        return self._recognition.execute(song)

    def run_with_clip(self, song: Song, process: Callable[[], None], cancel: Event) -> None:
        def download_clip() -> None:
            self._clip.execute(song, cancel)

        self._concurrency.run_concurrently(process, download_clip)
