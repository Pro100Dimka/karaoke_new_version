from __future__ import annotations

from dataclasses import replace
from collections.abc import Callable
from pathlib import Path
from threading import Event
from typing import Protocol
import logging

from backend.domain_errors import DomainError, NotFoundError
from backend.persistence import UnitOfWorkFactory
from backend.processing.ports import ConcurrentRunner
from backend.projects.content_lock import KeyedLockManager
from backend.projects.ports import ProjectStorage
from backend.runtime import Clock
from backend.songs.domain import Song
from backend.songs.refresh_recognition import RefreshSongRecognition

LOCAL_CLIP = "local:clip"


class ClipDownloader(Protocol):
    def is_complete(self, source: Path, cancel: Event | None = None) -> bool: ...

    def download(
        self,
        source_url: str,
        destination: Path,
        *,
        expected_duration: float | None,
        cancel: Event | None = None,
    ) -> bool: ...


def clip_path(
    song: Song, projects: ProjectStorage | None = None, revision: int | None = None
) -> Path | None:
    if projects is not None:
        target = revision if revision is not None else song.active_revision
        local = projects.video_path(song.song_id, target, prefer_local=True)
        if song.video_source_url and local.is_file():
            return local
        return projects.video_path(
            song.song_id, target, prefer_local="video" in song.user_overrides
        )
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
        projects: ProjectStorage | None = None,
    ) -> None:
        self._uow = uow
        self._downloader = downloader
        self._clock = clock
        self._locks = locks
        self._projects = projects

    def execute(
        self,
        song: Song,
        cancel: Event | None = None,
        *,
        required: bool = False,
        force: bool = False,
    ) -> Song:
        with self._locks.acquire(song.song_id):
            return self._execute(song, cancel, required=required, force=force)

    def _execute(self, song: Song, cancel: Event | None, *, required: bool, force: bool) -> Song:
        destination = (
            self._projects.video_path(song.song_id, song.active_revision, prefer_local=True)
            if self._projects
            else clip_path(song)
        )
        if destination is None:
            return song
        source_url = song.video_source_url or song.video_url or ""
        if song.video_url == LOCAL_CLIP and "video" in song.user_overrides:
            return song
        if source_url == LOCAL_CLIP:
            if required:
                raise DomainError(
                    "ClipSourceMissing", "The original clip URL must be restored", 422
                )
            return song
        if not source_url:
            return song
        existing = clip_path(song, self._projects)
        if (
            not force
            and song.video_url == LOCAL_CLIP
            and existing is not None
            and self._downloader.is_complete(existing, cancel)
        ):
            return self._save(song, source_url)
        ready = self._downloader.download(
            source_url, destination, expected_duration=song.duration, cancel=cancel
        )
        if cancel is not None and cancel.is_set():
            return song
        if not ready and required:
            raise DomainError("ClipUnavailable", "The clip could not be downloaded locally", 422)
        return self._save(song, source_url) if ready else song

    def _save(self, song: Song, source_url: str) -> Song:
        with self._uow.create() as transaction:
            current = transaction.songs.get(song.song_id)
            if current is None:
                raise NotFoundError("SongNotFound", "Song was not found", songId=song.song_id)
            if "video" in current.user_overrides:
                return current
            if current.video_url == LOCAL_CLIP and current.video_source_url == source_url:
                return current
            updated = replace(
                current,
                video_url=LOCAL_CLIP,
                video_source_url=source_url,
                updated_at=self._clock.now(),
            )
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
        clip_cancel = Event()

        def process_song() -> None:
            try:
                process()
            finally:
                # A missing optional clip must never hold a finished song or its AI lease.
                clip_cancel.set()

        def download_clip() -> None:
            try:
                if not clip_cancel.is_set() and not cancel.is_set():
                    self._clip.execute(song, clip_cancel)
            except (OSError, DomainError):
                logging.getLogger(__name__).warning(
                    "Optional song clip is unavailable", exc_info=True
                )

        self._concurrency.run_concurrently(process_song, download_clip)
