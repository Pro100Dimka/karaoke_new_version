from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

from backend.domain_errors import DependencyError, DomainError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.runtime import Clock
from backend.persistence import UnitOfWorkFactory
from backend.songs.domain import CoverState, Language, MetadataSource, Song
from backend.songs.ports import SongMediaUpdate, SongStorage
from backend.songs.prepare_clip import LOCAL_CLIP


@dataclass(frozen=True, slots=True)
class UpdateSongRequest:
    title: str | None = None
    artist: str | None = None
    language: Language | None = None
    cover_path: Path | None = None
    video_path: Path | None = None


class UpdateSong:
    def __init__(self, uow: UnitOfWorkFactory, storage: SongStorage, clock: Clock) -> None:
        self._uow = uow
        self._storage = storage
        self._clock = clock

    def mark_played(self, song_id: str, event_id: str) -> None:
        with self._uow.create() as transaction:
            if transaction.songs.get(song_id) is None:
                raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
            transaction.history.add(
                HistoryEvent(event_id, "SongPlayed", self._clock.now(), "Song", song_id)
            )
            transaction.commit()

    def execute(self, song_id: str, request: UpdateSongRequest) -> Song:
        with self._storage.media_update(song_id) as media, self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            if song is None:
                raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
            request = self._validate_media(request)
            updated = self._apply(song, request, media)
            fields = frozenset(
                name
                for name, value in {
                    "title": request.title,
                    "artist": request.artist,
                    "language": request.language,
                    "cover": request.cover_path,
                    "video": request.video_path,
                }.items()
                if value is not None
            )
            updated = transaction.songs.update_metadata(updated, fields)
            transaction.commit()
            media.commit()
        return updated

    def remove_custom_cover(self, song_id: str) -> Song:
        with self._storage.media_update(song_id) as media, self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            if song is None:
                raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
            overrides = set(song.user_overrides)
            overrides.discard("cover")
            fallback = (
                CoverState.EMBEDDED
                if song.metadata_provenance.get("cover") is MetadataSource.EMBEDDED
                else CoverState.FALLBACK
            )
            updated = replace(
                song,
                cover_path=None,
                cover_state=fallback,
                user_overrides=frozenset(overrides),
                updated_at=self._clock.now(),
            )
            updated = transaction.songs.update_metadata(updated, frozenset({"cover"}))
            transaction.commit()
            media.commit()
        return updated

    def _apply(self, song: Song, request: UpdateSongRequest, media: SongMediaUpdate) -> Song:
        provenance = dict(song.metadata_provenance)
        overrides = set(song.user_overrides)
        for field, value in (
            ("title", request.title),
            ("artist", request.artist),
            ("language", request.language),
        ):
            if value is not None:
                provenance[field] = MetadataSource.USER
                overrides.add(field)
        video_url = song.video_url
        if request.video_path is not None:
            media.copy_clip(request.video_path)
            video_url = LOCAL_CLIP
            overrides.add("video")
        cover_path, cover_state = song.cover_path, song.cover_state
        if request.cover_path is not None:
            cover_path = media.copy_cover(request.cover_path)
            cover_state = CoverState.CUSTOM
            overrides.add("cover")
        return replace(
            song,
            title=request.title if request.title is not None else song.title,
            artist=request.artist if request.artist is not None else song.artist,
            language=request.language if request.language is not None else song.language,
            video_url=video_url,
            cover_path=cover_path,
            cover_state=cover_state,
            metadata_provenance=provenance,
            user_overrides=frozenset(overrides),
            updated_at=self._clock.now(),
        )

    def _validate_media(self, request: UpdateSongRequest) -> UpdateSongRequest:
        video = self._validate_video(request.video_path) if request.video_path is not None else None
        cover = (
            request.cover_path.expanduser().resolve() if request.cover_path is not None else None
        )
        if cover is not None and not cover.is_file():
            raise NotFoundError("CoverNotFound", "Custom cover file was not found")
        return replace(request, cover_path=cover, video_path=video)

    def _validate_video(self, path: Path) -> Path:
        source = path.expanduser().resolve()
        if not source.is_file():
            raise NotFoundError("ClipMissing", "Selected video file was not found")
        try:
            with source.open("rb") as stream:
                header = stream.read(12)
        except OSError as error:
            raise DependencyError("StorageUnavailable", "Could not read selected video") from error
        if source.suffix.lower() != ".mp4" or header[4:8] != b"ftyp":
            raise DomainError("InvalidMedia", "Select an MP4 video")
        return source
