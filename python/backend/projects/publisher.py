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

_AUDIO_PATHS = {
    name: Path("audio") / filename
    for name, filename in {
        "instrumental": "instrumental.wav",
        "referenceVocal": "reference-vocal.wav",
        "melody": "melody.wav",
        "analysisVocal": "analysis-vocal.wav",
        "analysisInstrumental": "analysis-instrumental.wav",
        "rawVocal": "raw-vocal.wav",
    }.items()
}


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
        *,
        analysis_audio: Mapping[str, Path] | None = None,
    ) -> int:
        self._ensure_generated_baseline(song_id, expected_revision)
        revision = expected_revision + 1
        while self._storage.revision_exists(song_id, revision):
            revision += 1
        manifest, working = self._stage_generated(
            song_id,
            revision,
            {
                "instrumental": instrumental,
                "referenceVocal": reference_vocal,
                "melody": melody,
                **(analysis_audio or {}),
            },
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

    def _ensure_generated_baseline(self, song_id: str, expected_revision: int) -> None:
        # Generated timings must never silently replace a user's saved edits.
        previous = self._storage.load_manifest(song_id, expected_revision)
        checksums = {item.logical_name: item.checksum for item in previous.artifacts}
        for name in ("lyricsSync", "lyricsBaseline"):
            if name in checksums and not checksums[name]:
                checksums[name] = self._hasher(
                    self._storage.artifact_path(song_id, expected_revision, name)
                )
        if "lyricsSync" in checksums and checksums.get("lyricsBaseline") != checksums["lyricsSync"]:
            raise ConflictError(
                "ManualLyricsConflict",
                "The project has manual lyric or note edits. Export a backup and explicitly "
                "reset the editor to its AI baseline before regenerating timings.",
                revision=expected_revision,
            )

    def _stage_generated(
        self,
        song_id: str,
        revision: int,
        audio: Mapping[str, Path],
        lyrics: LyricsDocument,
        provenance: Mapping[str, object],
    ) -> tuple[ProjectManifest, Path]:
        lyrics_text = encode_document(lyrics)
        manifest = ProjectManifest(
            PROJECT_FORMAT_VERSION,
            song_id,
            revision,
            self._artifacts(audio, lyrics_text),
            provenance,
        )
        working = self._storage.stage_revision(
            song_id,
            revision,
            {_AUDIO_PATHS[name]: path for name, path in audio.items()},
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

    def _artifacts(
        self,
        audio: Mapping[str, Path],
        lyrics_text: str,
    ) -> tuple[ProjectArtifact, ...]:
        return tuple(
            ProjectArtifact(
                name,
                _AUDIO_PATHS[name],
                ArtifactCategory.PORTABLE,
                self._hasher(path),
            )
            for name, path in audio.items()
        ) + (
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
    def _text_files(lyrics_text: str, manifest: ProjectManifest) -> dict[Path, str]:
        return {
            Path("lyricsSync.json"): lyrics_text,
            Path("lyricsBaseline.json"): lyrics_text,
            Path("manifest.json"): encode_manifest(manifest),
        }


def _text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
