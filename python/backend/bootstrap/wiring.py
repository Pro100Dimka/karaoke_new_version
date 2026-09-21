from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from backend.ai.registry import AiProviderRegistry
from backend.bootstrap.config import BackendConfig
from backend.diagnostics.ports import RuntimeProbe
from backend.infrastructure.database import Database
from backend.infrastructure.local_projects import LocalProjectStorage
from backend.infrastructure.local_songs import LocalSongStorage
from backend.infrastructure.local_storage import LocalWorkStorage
from backend.infrastructure.process_runner import ProcessRunner
from backend.lyrics.ports import OnlineLyricsProvider
from backend.processing.job_manager import ProcessingJobManager
from backend.projects.content_lock import KeyedLockManager
from backend.projects.operations import SongOperationRegistry
from backend.projects.validator import ProjectValidator
from backend.recovery.ports import RecoveryJournal
from backend.runtime import Clock, IdGenerator
from backend.songs.ports import FileHasher
from backend.storage.ports import StorageSystem


@dataclass(frozen=True, slots=True)
class RuntimeWiring:
    config: BackendConfig
    database: Database
    processes: ProcessRunner
    clock: Clock
    ids: IdGenerator
    hasher: FileHasher


@dataclass(frozen=True, slots=True)
class ProjectWiring:
    projects: LocalProjectStorage
    songs: LocalSongStorage
    validator: ProjectValidator
    journal: RecoveryJournal
    locks: KeyedLockManager
    operations: SongOperationRegistry


@dataclass(frozen=True, slots=True)
class ProcessingWiring:
    jobs: ProcessingJobManager
    registry: AiProviderRegistry
    lyrics_providers: Sequence[OnlineLyricsProvider]
    workspaces: LocalWorkStorage
    runtime: RuntimeProbe
    storage: StorageSystem
