from __future__ import annotations

from dataclasses import replace

from backend.persistence import UnitOfWorkFactory
from backend.runtime import Clock
from backend.songs.domain import MetadataSource, Song
from backend.songs.recognition import SongRecognitionProvider


class RefreshSongRecognition:
    """Refreshes automatic catalog metadata without overwriting explicit user edits."""

    def __init__(
        self,
        uow: UnitOfWorkFactory,
        recognition: SongRecognitionProvider,
        clock: Clock,
    ) -> None:
        self._uow = uow
        self._recognition = recognition
        self._clock = clock

    def execute(self, song: Song) -> Song:
        if song.source_path is None or song.recognition_provider in {"Shazam", "AudD"}:
            return song
        recognized = self._recognition.recognize(song.source_path)
        if recognized is None:
            return song
        provenance = dict(song.metadata_provenance)
        title, artist = song.title, song.artist
        if "title" not in song.user_overrides:
            title = recognized.title
            provenance["title"] = MetadataSource.DETECTED
        if "artist" not in song.user_overrides:
            artist = recognized.artist
            provenance["artist"] = MetadataSource.DETECTED
        updated = replace(
            song,
            title=title,
            artist=artist,
            album=recognized.album or song.album,
            genre=recognized.genre or song.genre,
            artwork_url=recognized.artwork_url or song.artwork_url,
            video_url=recognized.video_url or song.video_url,
            recognition_provider=recognized.provider or song.recognition_provider,
            recognition_external_id=recognized.external_id or song.recognition_external_id,
            metadata_provenance=provenance,
            updated_at=self._clock.now(),
        )
        with self._uow.create() as transaction:
            transaction.songs.update(updated)
            transaction.commit()
        return updated
