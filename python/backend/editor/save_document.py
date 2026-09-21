from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path

from backend.domain_errors import ConflictError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.runtime import Clock, IdGenerator
from backend.projects.content_lock import KeyedLockManager
from backend.projects.operations import SongOperation, SongOperationRegistry
from backend.lyrics.codec import encode_document
from backend.lyrics.domain import LyricsDocument
from backend.persistence import UnitOfWorkFactory
from backend.projects.domain import ProjectManifest, ProjectRevision
from backend.projects.fingerprint import manifest_fingerprint
from backend.projects.manifest_codec import encode_manifest
from backend.projects.ports import ProjectStorage
from backend.projects.validator import ProjectValidator
from backend.recovery.domain import RecoveryOperation
from backend.recovery.ports import RecoveryJournal


class SaveEditorDocument:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        projects: ProjectStorage,
        validator: ProjectValidator,
        operations: SongOperationRegistry,
        locks: KeyedLockManager,
        journal: RecoveryJournal,
        clock: Clock,
        ids: IdGenerator,
    ) -> None:
        self._uow = uow
        self._projects = projects
        self._validator = validator
        self._operations = operations
        self._locks = locks
        self._journal = journal
        self._clock = clock
        self._ids = ids

    def execute(self, song_id: str, expected_revision: int, document: LyricsDocument) -> int:
        document.validate()
        with self._operations.acquire(song_id, SongOperation.EDITOR_SAVE):
            return self._save(song_id, expected_revision, document)

    def _save(self, song_id: str, expected_revision: int, document: LyricsDocument) -> int:
        manifest, lineage_id = self._load_base(song_id, expected_revision)
        new_revision = expected_revision + 1
        updated_manifest = _updated_manifest(manifest, new_revision, document)
        working = self._projects.clone_revision(song_id, expected_revision, new_revision)
        lyrics_text = encode_document(document)
        lyrics_path = _lyrics_path(updated_manifest)
        self._projects.write_working_text(working, lyrics_path, lyrics_text)
        self._projects.write_working_text(
            working, Path("manifest.json"), encode_manifest(updated_manifest)
        )
        self._validator.validate_working(updated_manifest, working, require_ready=True)
        entry = self._journal.begin(
            RecoveryOperation.PROJECT_PUBLISH,
            {"songId": song_id, "revision": new_revision, "working": str(working)},
        )
        self._commit(song_id, expected_revision, updated_manifest, lineage_id, working)
        self._journal.complete(entry.transaction_id)
        return new_revision

    def _load_base(self, song_id: str, expected_revision: int) -> tuple[ProjectManifest, str]:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            revision = transaction.projects.get(song_id, expected_revision)
        if song is None:
            raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
        if song.active_revision != expected_revision:
            raise ConflictError(
                "RevisionConflict",
                "Editor document is based on an old revision",
                expectedRevision=expected_revision,
                actualRevision=song.active_revision,
            )
        if revision is None:
            raise NotFoundError("ProjectInvalid", "Project revision metadata is missing")
        return self._projects.load_manifest(song_id, expected_revision), revision.lineage_id

    def _commit(
        self,
        song_id: str,
        expected_revision: int,
        manifest: ProjectManifest,
        lineage_id: str,
        working: Path,
    ) -> None:
        with self._locks.acquire(song_id):
            with self._uow.create() as transaction:
                song = transaction.songs.get(song_id)
                if song is None:
                    raise NotFoundError("SongNotFound", "Song was not found")
                if song.active_revision != expected_revision:
                    raise ConflictError("RevisionConflict", "Project changed during editor save")
                self._projects.publish_revision(song_id, manifest.revision, working)
                now = self._clock.now()
                transaction.songs.update(
                    replace(song, active_revision=manifest.revision, updated_at=now)
                )
                transaction.projects.add(
                    ProjectRevision(
                        song_id,
                        manifest.revision,
                        manifest_fingerprint(manifest),
                        manifest.project_format_version,
                        lineage_id,
                        now,
                    )
                )
                transaction.history.add(
                    HistoryEvent(self._ids.new(), "EditorSaved", now, "Song", song_id)
                )
                transaction.commit()


def _updated_manifest(
    manifest: ProjectManifest,
    revision: int,
    document: LyricsDocument,
) -> ProjectManifest:
    lyrics_text = encode_document(document)
    checksum = hashlib.sha256(lyrics_text.encode("utf-8")).hexdigest()
    artifacts = tuple(
        replace(artifact, checksum=checksum) if artifact.logical_name == "lyricsSync" else artifact
        for artifact in manifest.artifacts
    )
    return replace(manifest, revision=revision, artifacts=artifacts)


def _lyrics_path(manifest: ProjectManifest) -> Path:
    for artifact in manifest.artifacts:
        if artifact.logical_name == "lyricsSync":
            return artifact.relative_path
    raise NotFoundError("ProjectInvalid", "lyricsSync artifact is missing")
