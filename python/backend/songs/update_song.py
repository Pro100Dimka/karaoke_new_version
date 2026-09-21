from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

from backend.domain_errors import NotFoundError
from backend.runtime import Clock
from backend.persistence import UnitOfWorkFactory
from backend.songs.domain import CoverState, Language, MetadataSource, Song
from backend.songs.ports import SongStorage


@dataclass(frozen=True, slots=True)
class UpdateSongRequest:
    title: str | None = None
    artist: str | None = None
    language: Language | None = None
    cover_path: Path | None = None


class UpdateSong:
    def __init__(self, uow: UnitOfWorkFactory, storage: SongStorage, clock: Clock) -> None:
        self._uow = uow
        self._storage = storage
        self._clock = clock

    def execute(self, song_id: str, request: UpdateSongRequest) -> Song:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            if song is None:
                raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
            updated = self._apply(song, request)
            transaction.songs.update(updated)
            transaction.commit()
        return updated

    def _apply(self, song: Song, request: UpdateSongRequest) -> Song:
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
        cover_path, cover_state = song.cover_path, song.cover_state
        if request.cover_path is not None:
            source = request.cover_path.expanduser().resolve()
            if not source.is_file():
                raise NotFoundError("CoverNotFound", "Custom cover file was not found")
            cover_path = self._storage.copy_cover(song.song_id, source)
            cover_state = CoverState.CUSTOM
            overrides.add("cover")
        return replace(
            song,
            title=request.title if request.title is not None else song.title,
            artist=request.artist if request.artist is not None else song.artist,
            language=request.language if request.language is not None else song.language,
            cover_path=cover_path,
            cover_state=cover_state,
            metadata_provenance=provenance,
            user_overrides=frozenset(overrides),
            updated_at=self._clock.now(),
        )
