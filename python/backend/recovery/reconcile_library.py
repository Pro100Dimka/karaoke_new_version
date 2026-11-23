from __future__ import annotations

from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from collections.abc import Callable

from backend.domain_errors import DomainError
from backend.lyrics.discovery import lyrics_language
from backend.persistence import UnitOfWorkFactory
from backend.projects.ports import ProjectCatalog
from backend.projects.validator import ProjectValidator, READY_ARTIFACTS
from backend.recovery.domain import RecoveryAction, ReconciliationIssue
from backend.runtime import Clock
from backend.songs.domain import Language, Song, SongStatus, SourceState
from backend.songs.ports import SongStorage


class ReconcileLibrary:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        catalog: ProjectCatalog,
        validator: ProjectValidator,
        songs: SongStorage,
        clock: Clock,
    ) -> None:
        self._uow = uow
        self._catalog = catalog
        self._validator = validator
        self._songs = songs
        self._clock = clock

    def execute(
        self, *, workers: int = 1, check_cancel: Callable[[], None] | None = None
    ) -> tuple[ReconciliationIssue, ...]:
        database_songs = self._all_songs()
        known_ids = {song.song_id for song in database_songs}
        with ThreadPoolExecutor(max_workers=workers) if workers > 1 else nullcontext() as pool:
            results = (pool.map if pool else map)(self._song_issues, database_songs)
            issues = []
            for result in results:
                if check_cancel:
                    check_cancel()
                issues.extend(result)
        for song_id in self._catalog.song_ids():
            if song_id not in known_ids:
                issues.append(
                    ReconciliationIssue(
                        "OrphanProject",
                        song_id,
                        RecoveryAction.MANUAL_ACTION_REQUIRED,
                        {"revisions": self._catalog.revisions(song_id)},
                    )
                )
        return tuple(issues)

    def _all_songs(self) -> tuple[Song, ...]:
        songs: list[Song] = []
        with self._uow.create() as transaction:
            while page := transaction.songs.list(
                search=None,
                status=None,
                sort="createdAt",
                descending=False,
                limit=10_000,
                offset=len(songs),
            ):
                songs.extend(page)
        return tuple(songs)

    def _song_issues(self, song: Song) -> list[ReconciliationIssue]:
        issues: list[ReconciliationIssue] = []
        revisions = self._catalog.revisions(song.song_id)
        if song.active_revision not in revisions:
            issues.append(
                self._issue("MissingProject", song.song_id, RecoveryAction.REPROCESS_REQUIRED)
            )
            self._mark(song, SongStatus.PROJECT_INVALID)
            return issues
        if song.source_state is SourceState.MANAGED and (
            song.source_path is None or not self._songs.exists(song.source_path)
        ):
            issues.append(
                self._issue("SourceMissing", song.song_id, RecoveryAction.MANUAL_ACTION_REQUIRED)
            )
            self._mark(song, SongStatus.SOURCE_MISSING)
        issues.extend(self._project_issues(song))
        return issues

    def _project_issues(self, song: Song) -> list[ReconciliationIssue]:
        issues: list[ReconciliationIssue] = []
        try:
            manifest = self._validator.validate(
                song.song_id,
                song.active_revision,
                require_ready=song.status is SongStatus.READY,
            )
        except DomainError as exc:
            issues.append(
                ReconciliationIssue(
                    "CorruptArtifact",
                    song.song_id,
                    RecoveryAction.REPROCESS_REQUIRED,
                    {"errorCode": exc.code},
                )
            )
            self._mark(song, SongStatus.PROJECT_INVALID)
        else:
            status = song.status
            if song.status in {
                SongStatus.CANCELLED,
                SongStatus.FAILED,
            } and READY_ARTIFACTS.issubset(
                artifact.logical_name for artifact in manifest.artifacts
            ):
                status = SongStatus.READY
            detected = song.detected_language
            text = manifest.provenance.get("lyricsSourceText")
            if (
                detected is None
                and status is SongStatus.READY
                and isinstance(text, str)
                and text.strip()
            ):
                candidate = lyrics_language(replace(song, language=Language.AUTO), text)
                detected = candidate if candidate is not Language.AUTO else None
            self._mark(song, status, detected)
        return issues

    @staticmethod
    def _issue(code: str, entity_id: str, action: RecoveryAction) -> ReconciliationIssue:
        return ReconciliationIssue(code, entity_id, action, {})

    def _mark(self, expected: Song, status: SongStatus, detected: Language | None = None) -> None:
        detected = detected if detected is not None else expected.detected_language
        if expected.status is status and expected.detected_language is detected:
            return
        with self._uow.create(write=True) as transaction:
            song = transaction.songs.get(expected.song_id)
            if song is not None and song == expected:
                transaction.songs.update(
                    replace(
                        song,
                        status=status,
                        detected_language=detected,
                        updated_at=self._clock.now(),
                    )
                )
                transaction.commit()
