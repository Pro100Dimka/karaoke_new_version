from __future__ import annotations

from pathlib import Path, PurePosixPath
from collections.abc import Callable

from backend.domain_errors import NotFoundError
from backend.persistence import UnitOfWorkFactory
from backend.projects.domain import ProjectManifest, ProjectRevision
from backend.projects.ports import ProjectStorage
from backend.songs.domain import CoverState, Song
from backend.songs.ports import SongStorage
from backend.songs.prepare_clip import LOCAL_CLIP, clip_path


class SnapshotPackage:
    """Copies one revision and the song's selected media under the manual media edit lock."""

    def __init__(
        self, uow: UnitOfWorkFactory, projects: ProjectStorage, songs: SongStorage
    ) -> None:
        self._uow = uow
        self._projects = projects
        self._songs = songs

    def execute(
        self,
        song_id: str,
        revision: int | None,
        workspace: Path,
        *,
        ensure_not_cancelled: Callable[[], None] | None = None,
    ) -> tuple[Song, ProjectRevision, ProjectManifest, Path]:
        with self._songs.media_update(song_id):
            if ensure_not_cancelled:
                ensure_not_cancelled()
            song, metadata = self._load(song_id, revision)
            project = self._projects.load_manifest(song_id, metadata.revision)
            snapshot = self._snapshot(song, metadata.revision, workspace, ensure_not_cancelled)
        return song, metadata, project, snapshot

    def _load(self, song_id: str, revision: int | None) -> tuple[Song, ProjectRevision]:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            if song is None:
                raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
            target = revision if revision is not None else song.active_revision
            metadata = transaction.projects.get(song_id, target)
        if metadata is None:
            raise NotFoundError(
                "ProjectInvalid", "Project revision does not exist", revision=target
            )
        return song, metadata

    def _snapshot(
        self,
        song: Song,
        revision: int,
        workspace: Path,
        ensure_not_cancelled: Callable[[], None] | None,
    ) -> Path:
        supplemental: dict[Path, Path] = {}
        clip = clip_path(song, self._projects, revision)
        if song.video_url == LOCAL_CLIP and clip is not None and clip.is_file():
            supplemental[Path("media/clip.mp4")] = clip
        cover = custom_cover_path(song)
        if cover is not None:
            if song.cover_path is None or not song.cover_path.is_file():
                raise NotFoundError("CoverMissing", "Custom song cover is unavailable")
            supplemental[Path(*cover.parts)] = song.cover_path
        return self._projects.snapshot_revision(
            song.song_id,
            revision,
            workspace,
            supplemental_files=supplemental,
            portable_only=True,
            ensure_not_cancelled=ensure_not_cancelled,
        )


def custom_cover_path(song: Song) -> PurePosixPath | None:
    if song.cover_state is not CoverState.CUSTOM:
        return None
    if song.cover_path is None:
        raise NotFoundError("CoverMissing", "Custom song cover is unavailable")
    return PurePosixPath(f"song-media/cover{song.cover_path.suffix.lower()}")
