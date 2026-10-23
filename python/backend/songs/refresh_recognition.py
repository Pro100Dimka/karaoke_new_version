from __future__ import annotations

from dataclasses import replace

from backend.persistence import UnitOfWorkFactory
from backend.runtime import Clock
from backend.songs.domain import MetadataSource, Song
from backend.songs.filename_metadata import conflicts_with_filename
from backend.songs.recognition import (
    RecognizedSong,
    SongCatalogLookup,
    SongRecognitionProvider,
    prefer_equivalent_local_spelling,
)


class RefreshSongRecognition:
    """Refreshes automatic catalog metadata without overwriting explicit user edits."""

    def __init__(
        self,
        uow: UnitOfWorkFactory,
        recognition: SongRecognitionProvider,
        clock: Clock,
        catalog: SongCatalogLookup | None = None,
    ) -> None:
        self._uow = uow
        self._recognition = recognition
        self._clock = clock
        self._catalog = catalog

    def execute(self, song: Song) -> Song:
        recognized = self._recognize(song)
        if recognized is None:
            return song
        provenance = dict(song.metadata_provenance)
        title, artist = song.title, song.artist
        if "title" not in song.user_overrides:
            title = prefer_equivalent_local_spelling(song.title, recognized.title)
            provenance["title"] = MetadataSource.DETECTED
        if "artist" not in song.user_overrides:
            artist = prefer_equivalent_local_spelling(song.artist, recognized.artist)
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

    def _recognize(self, song: Song) -> RecognizedSong | None:
        fingerprinted = song.recognition_provider in {"Shazam", "AudD"}
        if song.source_path is None or (fingerprinted and song.video_url):
            return None
        recognized = self._recognition.recognize(song.source_path)
        if recognized is None or (
            not recognized.matches_identity(song.title, song.artist)
            and (
                fingerprinted
                or conflicts_with_filename(
                    song.original_filename or song.source_path.name,
                    recognized.artist,
                    recognized.title,
                )
            )
        ):
            return self._from_catalog(song)
        return recognized

    def _from_catalog(self, song: Song) -> RecognizedSong | None:
        found = self._catalog.lookup(song.artist, song.title) if self._catalog else None
        if found is None or not found.matches_identity(song.title, song.artist):
            return None
        return replace(
            found,
            provider=song.recognition_provider or found.provider,
            external_id=song.recognition_external_id or found.external_id,
        )
