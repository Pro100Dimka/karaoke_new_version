from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path
from typing import Mapping

from backend.domain_errors import ConflictError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.lyrics.codec import encode_document
from backend.lyrics.domain import LyricsDocument
from backend.persistence import UnitOfWork, UnitOfWorkFactory
from backend.projects.content_lock import KeyedLockManager
from backend.projects.domain import (
    ArtifactCategory,
    ProjectArtifact,
    ProjectManifest,
    ProjectRevision,
)
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import encode_manifest
from backend.projects.ports import ProjectStorage
from backend.projects.validator import ProjectValidator
from backend.recovery.domain import RecoveryOperation
from backend.recovery.ports import RecoveryJournal
from backend.runtime import Clock, IdGenerator
from backend.songs.domain import Song, SongStatus
from backend.songs.ports import FileHasher
from backend.version import PROJECT_FORMAT_VERSION


class ProjectPublisher:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        storage: ProjectStorage,
        validator: ProjectValidator,
        hasher: FileHasher,
        journal: RecoveryJournal,
        locks: KeyedLockManager,
        clock: Clock,
        ids: IdGenerator,
    ) -> None:
        self._uow = uow
        self._storage = storage
        self._validator = validator
        self._hasher = hasher
        self._journal = journal
        self._locks = locks
        self._clock = clock
        self._ids = ids

    def publish_generated(
        self,
        song_id: str,
        expected_revision: int,
        instrumental: Path,
        reference_vocal: Path,
        melody: Path,
        lyrics: LyricsDocument,
        provenance: Mapping[str, object],
        lineage_id: str,
    ) -> int:
        manifest, working = self._stage_generated(
            song_id,
            expected_revision + 1,
            instrumental,
            reference_vocal,
            melody,
            lyrics,
            provenance,
        )
        entry = self._journal.begin(
            RecoveryOperation.PROJECT_PUBLISH,
            {"songId": song_id, "revision": manifest.revision, "working": str(working)},
        )
        self._commit(song_id, expected_revision, manifest, lineage_id, working, lyrics)
        self._journal.complete(entry.transaction_id)
        return manifest.revision

    def _stage_generated(
        self,
        song_id: str,
        revision: int,
        instrumental: Path,
        reference_vocal: Path,
        melody: Path,
        lyrics: LyricsDocument,
        provenance: Mapping[str, object],
    ) -> tuple[ProjectManifest, Path]:
        lyrics_text = encode_document(lyrics)
        manifest = self._manifest(
            song_id,
            revision,
            instrumental,
            reference_vocal,
            melody,
            lyrics_text,
            provenance,
        )
        working = self._storage.stage_revision(
            song_id,
            revision,
            self._audio_files(instrumental, reference_vocal, melody),
            self._text_files(lyrics_text, manifest),
        )
        self._validator.validate_working(manifest, working, require_ready=True)
        return manifest, working

    def _commit(
        self,
        song_id: str,
        expected_revision: int,
        manifest: ProjectManifest,
        lineage_id: str,
        working: Path,
        lyrics: LyricsDocument,
    ) -> None:
        with self._locks.acquire(song_id):
            with self._uow.create() as transaction:
                song = self._expected_song(transaction, song_id, expected_revision)
                self._storage.publish_revision(song_id, manifest.revision, working)
                self._persist(transaction, song, manifest, lineage_id, lyrics)
                transaction.commit()

    def _expected_song(
        self,
        transaction: UnitOfWork,
        song_id: str,
        expected_revision: int,
    ) -> Song:
        song = transaction.songs.get(song_id)
        if song is None:
            raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
        if song.active_revision != expected_revision:
            raise ConflictError(
                "RevisionConflict",
                "Project revision changed while operation was running",
                expectedRevision=expected_revision,
                actualRevision=song.active_revision,
            )
        return song

    def _persist(
        self,
        transaction: UnitOfWork,
        song: Song,
        manifest: ProjectManifest,
        lineage_id: str,
        lyrics: LyricsDocument,
    ) -> None:
        now = self._clock.now()
        transaction.songs.update(
            replace(
                song,
                active_revision=manifest.revision,
                project_format_version=manifest.project_format_version,
                status=SongStatus.READY,
                detected_bpm=lyrics.bpm,
                detected_key=lyrics.key,
                updated_at=now,
            )
        )
        transaction.projects.add(
            ProjectRevision(
                song_id=song.song_id,
                revision=manifest.revision,
                fingerprint=manifest_fingerprint(manifest),
                project_format_version=manifest.project_format_version,
                lineage_id=lineage_id,
                created_at=now,
            )
        )
        transaction.history.add(
            HistoryEvent(self._ids.new(), "ProcessingSucceeded", now, "Song", song.song_id)
        )

    def _manifest(
        self,
        song_id: str,
        revision: int,
        instrumental: Path,
        reference_vocal: Path,
        melody: Path,
        lyrics_text: str,
        provenance: Mapping[str, object],
    ) -> ProjectManifest:
        artifacts = self._artifacts(instrumental, reference_vocal, melody, lyrics_text)
        return ProjectManifest(PROJECT_FORMAT_VERSION, song_id, revision, artifacts, provenance)

    def _artifacts(
        self,
        instrumental: Path,
        reference_vocal: Path,
        melody: Path,
        lyrics_text: str,
    ) -> tuple[ProjectArtifact, ...]:
        return (
            ProjectArtifact(
                "instrumental",
                Path("audio/instrumental.wav"),
                ArtifactCategory.PORTABLE,
                self._hasher.hash_file(instrumental),
            ),
            ProjectArtifact(
                "referenceVocal",
                Path("audio/reference-vocal.wav"),
                ArtifactCategory.PORTABLE,
                self._hasher.hash_file(reference_vocal),
            ),
            ProjectArtifact(
                "melody",
                Path("audio/melody.wav"),
                ArtifactCategory.PORTABLE,
                self._hasher.hash_file(melody),
            ),
            ProjectArtifact(
                "lyricsSync",
                Path("lyricsSync.json"),
                ArtifactCategory.PORTABLE,
                _text_hash(lyrics_text),
            ),
            ProjectArtifact(
                "lyricsBaseline",
                Path("lyricsBaseline.json"),
                ArtifactCategory.PORTABLE,
                _text_hash(lyrics_text),
            ),
        )

    @staticmethod
    def _audio_files(instrumental: Path, reference_vocal: Path, melody: Path) -> dict[Path, Path]:
        return {
            Path("audio/instrumental.wav"): instrumental,
            Path("audio/reference-vocal.wav"): reference_vocal,
            Path("audio/melody.wav"): melody,
        }

    @staticmethod
    def _text_files(lyrics_text: str, manifest: ProjectManifest) -> dict[Path, str]:
        return {
            Path("lyricsSync.json"): lyrics_text,
            Path("lyricsBaseline.json"): lyrics_text,
            Path("manifest.json"): encode_manifest(manifest),
        }


def _text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
