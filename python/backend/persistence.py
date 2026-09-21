from __future__ import annotations

from types import TracebackType
from typing import Protocol, Self

from backend.analysis.ports import AnalysisRepository
from backend.history.ports import HistoryRepository
from backend.idempotency import IdempotencyRepository
from backend.models.ports import ModelRepository
from backend.processing.ports import JobRepository
from backend.projects.ports import ProjectRevisionRepository
from backend.recordings.ports import RecordingRepository
from backend.settings.ports import SettingsRepository
from backend.songs.ports import SongRepository


class UnitOfWork(Protocol):
    songs: SongRepository
    projects: ProjectRevisionRepository
    jobs: JobRepository
    recordings: RecordingRepository
    analyses: AnalysisRepository
    models: ModelRepository
    history: HistoryRepository
    settings: SettingsRepository
    idempotency: IdempotencyRepository

    def __enter__(self) -> Self: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool | None: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...


class UnitOfWorkFactory(Protocol):
    def create(self) -> UnitOfWork: ...
