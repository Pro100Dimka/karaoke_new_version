from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Protocol

from backend.persistence import UnitOfWorkFactory
from backend.runtime import Clock
from backend.songs.domain import Song
from backend.songs.refresh_recognition import RefreshSongRecognition

LOCAL_CLIP = "local:clip"


class ClipDownloader(Protocol):
    def download(
        self, source_url: str, destination: Path, *, expected_duration: float | None
    ) -> bool: ...


def clip_path(song: Song) -> Path | None:
    if song.source_path is None:
        return None
    return song.source_path.parent.parent / "media" / "clip.mp4"


class PrepareSongClip:
    def __init__(self, uow: UnitOfWorkFactory, downloader: ClipDownloader, clock: Clock) -> None:
        self._uow = uow
        self._downloader = downloader
        self._clock = clock

    def execute(self, song: Song) -> Song:
        destination = clip_path(song)
        if destination is None:
            return song
        if destination.is_file():
            return self._save(song, LOCAL_CLIP) if song.video_url != LOCAL_CLIP else song
        source_url = song.video_url or ""
        if not source_url:
            return song
        ready = self._downloader.download(
            source_url, destination, expected_duration=song.duration
        )
        return self._save(song, LOCAL_CLIP if ready else None)

    def _save(self, song: Song, video_url: str | None) -> Song:
        updated = replace(song, video_url=video_url, updated_at=self._clock.now())
        with self._uow.create() as transaction:
            transaction.songs.update(updated)
            transaction.commit()
        return updated


class PrepareSong:
    def __init__(self, recognition: RefreshSongRecognition, clip: PrepareSongClip) -> None:
        self._recognition = recognition
        self._clip = clip

    def execute(self, song: Song) -> Song:
        return self._recognition.execute(song)

    def download_clip(self, song: Song) -> Song:
        return self._clip.execute(song)
