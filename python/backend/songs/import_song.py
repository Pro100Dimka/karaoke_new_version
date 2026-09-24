from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, TypedDict

from backend.domain_errors import ConflictError, DomainError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.idempotency import IdempotencyRecord
from backend.runtime import Clock
from backend.runtime import IdGenerator
from backend.persistence import UnitOfWorkFactory
from backend.projects.domain import ProjectRevision
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.ports import ProjectStorage
from backend.recovery.domain import RecoveryOperation
from backend.recovery.ports import RecoveryJournal
from backend.songs.domain import (
    CoverState,
    Language,
    MetadataSource,
    Song,
    SongStatus,
    SourceState,
)
from backend.songs.filename_metadata import UNKNOWN_ARTIST, with_filename_fallback
from backend.songs.ports import FileHasher, MediaInspector, MediaMetadata, SongStorage
from backend.songs.recognition import RecognizedSong, SongRecognitionProvider
from backend.version import PROJECT_FORMAT_VERSION

_ALLOWED_SUFFIXES = frozenset({".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wma"})


@dataclass(frozen=True, slots=True)
class ImportSongRequest:
    source_path: Path
    title: str | None = None
    artist: str | None = None
    language: Language = Language.AUTO
    idempotency_key: str | None = None


class ImportSong:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        storage: SongStorage,
        projects: ProjectStorage,
        media: MediaInspector,
        hasher: FileHasher,
        journal: RecoveryJournal,
        clock: Clock,
        ids: IdGenerator,
        recognition: SongRecognitionProvider,
    ) -> None:
        self._uow = uow
        self._storage = storage
        self._projects = projects
        self._media = media
        self._hasher = hasher
        self._journal = journal
        self._clock = clock
        self._ids = ids
        self._recognition = recognition

    def execute(
        self,
        request: ImportSongRequest,
        progress: Callable[[str, float], None] | None = None,
        ensure_not_cancelled: Callable[[], None] | None = None,
    ) -> Song:
        source = request.source_path.expanduser().resolve()
        self._validate_source(source)
        _checkpoint(progress, ensure_not_cancelled, "Validating", 0.05)
        request_hash = _request_hash(request, source)
        repeated = self._idempotent_result(request.idempotency_key, request_hash)
        if repeated:
            _checkpoint(progress, ensure_not_cancelled, "Completed", 1.0)
            return repeated
        identity = self._hasher.hash_file(source)
        _checkpoint(progress, ensure_not_cancelled, "Hashing", 0.2)
        self._ensure_not_duplicate(identity)
        embedded = self._media.inspect(source)
        _checkpoint(progress, ensure_not_cancelled, "ReadingMetadata", 0.35)
        metadata = with_filename_fallback(embedded, source)
        recognized = self._recognition.recognize(source)
        _checkpoint(progress, ensure_not_cancelled, "Recognizing", 0.5)
        song_id = self._ids.new()
        entry = self._journal.begin(
            RecoveryOperation.IMPORT_SONG,
            {"songId": song_id, "sourceIdentity": identity},
        )
        try:
            song = self._prepare_song(
                song_id, source, identity, request, metadata, embedded, recognized
            )
            _checkpoint(progress, ensure_not_cancelled, "Copying", 0.9)
            self._persist(song, request.idempotency_key, request_hash)
            _checkpoint(progress, ensure_not_cancelled, "Saving", 0.98)
        except DomainError:
            self._cleanup_failed_import(song_id)
            self._journal.complete(entry.transaction_id)
            raise
        self._journal.complete(entry.transaction_id)
        return song

    def _prepare_song(
        self,
        song_id: str,
        source: Path,
        identity: str,
        request: ImportSongRequest,
        metadata: MediaMetadata,
        embedded: MediaMetadata,
        recognized: RecognizedSong | None,
    ) -> Song:
        managed = self._storage.copy_source(song_id, source, identity)
        cover_state, cover_path = self._cover(song_id, managed)
        self._projects.create_imported(song_id, 1, managed)
        now = self._clock.now()
        title = (
            request.title or (recognized.title if recognized else None) or metadata.title
        ).strip()
        artist = (
            request.artist or (recognized.artist if recognized else None) or metadata.artist
        ).strip()
        provenance = _provenance(request, embedded, source, recognized is not None)
        overrides = _user_overrides(request)
        return _new_imported_song(
            song_id,
            identity,
            managed,
            request,
            metadata,
            recognized,
            cover_state,
            cover_path,
            title,
            artist,
            provenance,
            overrides,
            now,
        )

    def _persist(self, song: Song, idempotency_key: str | None, request_hash: str) -> None:
        manifest = self._projects.load_manifest(song.song_id, song.active_revision)
        revision = ProjectRevision(
            song_id=song.song_id,
            revision=song.active_revision,
            fingerprint=manifest_fingerprint(manifest),
            project_format_version=manifest.project_format_version,
            lineage_id=self._ids.new(),
            created_at=song.created_at,
        )
        event = HistoryEvent(self._ids.new(), "SongImported", song.created_at, "Song", song.song_id)
        with self._uow.create() as transaction:
            transaction.songs.add(song)
            transaction.projects.add(revision)
            transaction.history.add(event)
            if idempotency_key:
                transaction.idempotency.add(
                    IdempotencyRecord(
                        "ImportSong", idempotency_key, request_hash, song.song_id, song.created_at
                    )
                )
            transaction.commit()

    def _idempotent_result(self, key: str | None, request_hash: str) -> Song | None:
        if not key:
            return None
        with self._uow.create() as transaction:
            record = transaction.idempotency.get("ImportSong", key)
            if record is None:
                return None
            if record.request_hash != request_hash:
                raise ConflictError(
                    "IdempotencyConflict", "Idempotency key was reused with different input"
                )
            song = transaction.songs.get(record.response_json)
        if song is None:
            raise DomainError(
                "IdempotencyStateInvalid", "Stored idempotent result no longer exists", 500
            )
        return song

    def _ensure_not_duplicate(self, identity: str) -> None:
        with self._uow.create() as transaction:
            existing = transaction.songs.get_by_source_identity(identity)
        if existing:
            raise ConflictError(
                "DuplicateSong",
                "Song with the same content already exists",
                existingSongId=existing.song_id,
            )

    def _cover(self, song_id: str, source: Path) -> tuple[CoverState, Path | None]:
        target = source.parent.parent / "cover" / "embedded.jpg"
        if self._media.extract_artwork(source, target):
            return CoverState.EMBEDDED, target
        return CoverState.FALLBACK, None

    def _cleanup_failed_import(self, song_id: str) -> None:
        quarantine = self._storage.quarantine(song_id)
        if quarantine:
            self._storage.finalize_quarantine(quarantine)

    @staticmethod
    def _validate_source(source: Path) -> None:
        if not source.is_file():
            raise NotFoundError("SourceMissing", "Selected media file does not exist")
        if source.suffix.lower() not in _ALLOWED_SUFFIXES:
            raise DomainError("UnsupportedMedia", "Unsupported media format", 415)


def _new_imported_song(
    song_id: str,
    identity: str,
    managed: Path,
    request: ImportSongRequest,
    metadata: MediaMetadata,
    recognized: RecognizedSong | None,
    cover_state: CoverState,
    cover_path: Path | None,
    title: str,
    artist: str,
    provenance: dict[str, MetadataSource],
    overrides: frozenset[str],
    now: datetime,
) -> Song:
    return Song(
        song_id=song_id,
        title=title,
        artist=artist,
        **_recognition_fields(recognized, metadata),
        source_identity=identity,
        source_state=SourceState.MANAGED,
        source_path=managed,
        duration=metadata.duration,
        media_format=metadata.media_format,
        embedded_lyrics=metadata.embedded_lyrics,
        language=request.language,
        cover_state=cover_state,
        cover_path=cover_path,
        status=SongStatus.IMPORTED,
        active_revision=1,
        project_format_version=PROJECT_FORMAT_VERSION,
        metadata_provenance=provenance,
        user_overrides=overrides,
        original_filename=request.source_path.name,
        created_at=now,
        updated_at=now,
    )


class _RecognitionFields(TypedDict):
    album: str | None
    genre: str | None
    artwork_url: str | None
    video_url: str | None
    recognition_provider: str | None
    recognition_external_id: str | None


def _recognition_fields(
    recognized: RecognizedSong | None, metadata: MediaMetadata
) -> _RecognitionFields:
    return {
        "album": recognized.album if recognized and recognized.album else metadata.album,
        "genre": recognized.genre if recognized else None,
        "artwork_url": recognized.artwork_url if recognized else None,
        "video_url": recognized.video_url if recognized else None,
        "recognition_provider": recognized.provider if recognized else None,
        "recognition_external_id": recognized.external_id if recognized else None,
    }


def _request_hash(request: ImportSongRequest, source: Path) -> str:
    parts = (str(source), request.title or "", request.artist or "", request.language.value)
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()


def _provenance(
    request: ImportSongRequest, metadata: MediaMetadata, source: Path, recognized: bool
) -> dict[str, MetadataSource]:
    title_source = (
        MetadataSource.USER
        if request.title
        else (MetadataSource.DETECTED if recognized else MetadataSource.EMBEDDED)
    )
    if not request.title and metadata.title == source.stem:
        title_source = MetadataSource.FILENAME
    artist_source = (
        MetadataSource.USER
        if request.artist
        else (MetadataSource.DETECTED if recognized else MetadataSource.EMBEDDED)
    )
    if not request.artist and metadata.artist == UNKNOWN_ARTIST:
        artist_source = MetadataSource.FILENAME
    language_source = (
        MetadataSource.USER if request.language is not Language.AUTO else MetadataSource.DETECTED
    )
    return {"title": title_source, "artist": artist_source, "language": language_source}


def _user_overrides(request: ImportSongRequest) -> frozenset[str]:
    fields = {"title": request.title, "artist": request.artist}
    return frozenset(key for key, value in fields.items() if value)


def _checkpoint(
    progress: Callable[[str, float], None] | None,
    ensure_not_cancelled: Callable[[], None] | None,
    stage: str,
    value: float,
) -> None:
    if ensure_not_cancelled:
        ensure_not_cancelled()
    if progress:
        progress(stage, value)
