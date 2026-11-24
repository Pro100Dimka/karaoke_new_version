from __future__ import annotations

from pathlib import Path
from typing import Callable, Mapping, Protocol

from backend.projects.domain import ProjectManifest, ProjectRevision


class ProjectStorage(Protocol):
    def create_imported(self, song_id: str, revision: int, source: Path) -> ProjectManifest: ...

    def load_manifest(self, song_id: str, revision: int) -> ProjectManifest: ...

    def video_path(self, song_id: str, revision: int, *, prefer_local: bool = False) -> Path: ...

    def read_text_artifact(self, song_id: str, revision: int, logical_name: str) -> str: ...

    def artifact_path(self, song_id: str, revision: int, logical_name: str) -> Path: ...

    def begin_revision(self, song_id: str, revision: int) -> Path: ...

    def stage_revision(
        self,
        song_id: str,
        revision: int,
        files: Mapping[Path, Path],
        texts: Mapping[Path, str],
        *,
        base_revision: int | None = None,
    ) -> Path: ...

    def working_path(self, working: Path, relative_path: Path) -> Path: ...

    def read_working_text(self, working: Path, relative_path: Path) -> str: ...

    def write_working_text(self, working: Path, relative_path: Path, text: str) -> None: ...

    def clone_revision(self, song_id: str, source_revision: int, target_revision: int) -> Path: ...

    def publish_revision(self, song_id: str, revision: int, working: Path) -> None: ...

    def snapshot_revision(
        self,
        song_id: str,
        revision: int,
        destination: Path,
        *,
        supplemental_files: Mapping[Path, Path] | None = None,
        portable_only: bool = False,
        ensure_not_cancelled: Callable[[], None] | None = None,
    ) -> Path: ...

    def revision_exists(self, song_id: str, revision: int) -> bool: ...

    def revisions(self, song_id: str) -> tuple[int, ...]: ...

    def remove_revision(self, song_id: str, revision: int) -> None: ...

    def install_revision_artifact(
        self, song_id: str, revision: int, relative_path: Path, source: Path,
        *,
        publish: Callable[[Path, Path], None] | None = None,
        ensure_not_cancelled: Callable[[], None] | None = None,
    ) -> None: ...

    def portable_revision_size(self, song_id: str, revision: int) -> int: ...


class ProjectRevisionRepository(Protocol):
    def get(self, song_id: str, revision: int) -> ProjectRevision | None: ...

    def add(self, revision: ProjectRevision) -> None: ...


class AudioFileValidator(Protocol):
    def validate(self, path: Path) -> None: ...


class ProjectCatalog(Protocol):
    def song_ids(self) -> tuple[str, ...]: ...

    def revisions(self, song_id: str) -> tuple[int, ...]: ...
