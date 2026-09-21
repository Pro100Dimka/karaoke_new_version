from __future__ import annotations

from dataclasses import replace

from backend.domain_errors import DomainError
from backend.persistence import UnitOfWorkFactory
from backend.projects.ports import ProjectCatalog
from backend.projects.validator import ProjectValidator
from backend.recovery.domain import RecoveryAction, ReconciliationIssue
from backend.runtime import Clock
from backend.songs.domain import Song, SongStatus, SourceState
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

    def execute(self) -> tuple[ReconciliationIssue, ...]:
        database_songs = self._all_songs()
        known_ids = {song.song_id for song in database_songs}
        issues: list[ReconciliationIssue] = []
        for song in database_songs:
            issues.extend(self._song_issues(song))
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
        with self._uow.create() as transaction:
            songs = transaction.songs.list(
                search=None,
                status=None,
                sort="createdAt",
                descending=False,
                limit=10_000,
                offset=0,
            )
        return tuple(songs)

    def _song_issues(self, song: Song) -> list[ReconciliationIssue]:
        issues: list[ReconciliationIssue] = []
        revisions = self._catalog.revisions(song.song_id)
        if song.active_revision not in revisions:
            issues.append(
                self._issue("MissingProject", song.song_id, RecoveryAction.REPROCESS_REQUIRED)
            )
            self._mark(song.song_id, SongStatus.PROJECT_INVALID)
            return issues
        if song.source_state is SourceState.MANAGED and (
            song.source_path is None or not self._songs.exists(song.source_path)
        ):
            issues.append(
                self._issue("SourceMissing", song.song_id, RecoveryAction.MANUAL_ACTION_REQUIRED)
            )
            self._mark(song.song_id, SongStatus.SOURCE_MISSING)
        try:
            self._validator.validate(
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
            self._mark(song.song_id, SongStatus.PROJECT_INVALID)
        return issues

    @staticmethod
    def _issue(code: str, entity_id: str, action: RecoveryAction) -> ReconciliationIssue:
        return ReconciliationIssue(code, entity_id, action, {})

    def _mark(self, song_id: str, status: SongStatus) -> None:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            if song and song.status is not status:
                transaction.songs.update(replace(song, status=status, updated_at=self._clock.now()))
                transaction.commit()
