from __future__ import annotations

from pathlib import Path

from backend.domain_errors import DomainError
from backend.lyrics.codec import decode_document
from backend.projects.domain import ProjectArtifact, ProjectManifest
from backend.projects.ports import AudioFileValidator, ProjectStorage
from backend.songs.ports import FileHasher
from backend.version import PROJECT_FORMAT_VERSION

_READY_ARTIFACTS = frozenset({"instrumental", "referenceVocal", "lyricsSync"})
# Melody is validated as audio when present, but left out of _READY_ARTIFACTS: revisions published
# before this artifact existed must keep validating as ready without it.
_AUDIO_ARTIFACTS = frozenset({"instrumental", "referenceVocal", "melody"})


class ProjectValidator:
    def __init__(
        self, storage: ProjectStorage, hasher: FileHasher, audio: AudioFileValidator
    ) -> None:
        self._storage = storage
        self._hasher = hasher
        self._audio = audio

    def validate(self, song_id: str, revision: int, *, require_ready: bool) -> ProjectManifest:
        manifest = self._storage.load_manifest(song_id, revision)
        self._validate_manifest(manifest, song_id, revision, require_ready)
        for artifact in manifest.artifacts:
            path = self._storage.artifact_path(song_id, revision, artifact.logical_name)
            self._validate_file(path, artifact)
        if any(item.logical_name == "lyricsSync" for item in manifest.artifacts):
            raw = self._storage.read_text_artifact(song_id, revision, "lyricsSync")
            self._validate_lyrics(raw)
        return manifest

    def validate_working(
        self,
        manifest: ProjectManifest,
        working: Path,
        *,
        require_ready: bool,
    ) -> None:
        self._validate_manifest(manifest, manifest.song_id, manifest.revision, require_ready)
        for artifact in manifest.artifacts:
            path = self._storage.working_path(working, artifact.relative_path)
            self._validate_file(path, artifact)
        lyrics = next(
            (item for item in manifest.artifacts if item.logical_name == "lyricsSync"),
            None,
        )
        if lyrics:
            raw = self._storage.read_working_text(working, lyrics.relative_path)
            self._validate_lyrics(raw)

    @staticmethod
    def _validate_manifest(
        manifest: ProjectManifest,
        song_id: str,
        revision: int,
        require_ready: bool,
    ) -> None:
        if manifest.song_id != song_id or manifest.revision != revision:
            raise DomainError(
                "ProjectInvalid", "Project manifest identity does not match location", 400
            )
        if manifest.project_format_version != PROJECT_FORMAT_VERSION:
            raise DomainError("ProjectUpgradeRequired", "Project format is not current", 409)
        names = [artifact.logical_name for artifact in manifest.artifacts]
        if len(names) != len(set(names)):
            raise DomainError(
                "ProjectInvalid", "Project manifest contains duplicate logical artifacts", 400
            )
        if require_ready and not _READY_ARTIFACTS.issubset(names):
            raise DomainError("ProjectInvalid", "Ready project is missing required artifacts", 400)
        for artifact in manifest.artifacts:
            _validate_relative_path(artifact)

    def _validate_file(self, path: Path, artifact: ProjectArtifact) -> None:
        if not path.is_file():
            raise DomainError(
                "ProjectInvalid",
                "Project artifact is missing",
                400,
                {"artifact": artifact.logical_name},
            )
        if artifact.checksum and self._hasher.hash_file(path) != artifact.checksum:
            raise DomainError(
                "ProjectInvalid",
                "Project artifact checksum failed",
                400,
                {"artifact": artifact.logical_name},
            )
        if artifact.logical_name in _AUDIO_ARTIFACTS:
            self._audio.validate(path)

    @staticmethod
    def _validate_lyrics(raw: str) -> None:
        try:
            decode_document(raw)
        except ValueError as exc:
            raise DomainError("ProjectInvalid", "lyricsSync.json is invalid", 400) from exc


def _validate_relative_path(artifact: ProjectArtifact) -> None:
    path = artifact.relative_path
    if path.is_absolute() or path.drive or ".." in path.parts:
        raise DomainError("ProjectInvalid", "Project artifact path is unsafe", 400)
