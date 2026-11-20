from __future__ import annotations

import os
import threading
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

from backend.infrastructure.lossless_audio import compress_audio
from backend.infrastructure.process_runner import ProcessRunner
from backend.lyrics.codec import decode_document
from backend.lyrics.domain import LyricsDocument
from backend.processing.melody_reference import RenderMelodyReference
from backend.projects.domain import ArtifactCategory, ProjectArtifact, ProjectManifest
from backend.projects.ports import ProjectStorage
from backend.songs.ports import FileHasher


class UpdateEditorMelody:
    """Keep the published listen-only guide synchronized with the edited notes."""

    def __init__(
        self,
        projects: ProjectStorage,
        renderer: RenderMelodyReference,
        processes: ProcessRunner,
        hasher: FileHasher,
    ) -> None:
        self._projects = projects
        self._renderer = renderer
        self._processes = processes
        self._hasher = hasher

    def update(
        self, manifest: ProjectManifest, working: Path, document: LyricsDocument
    ) -> ProjectManifest:
        lyrics = next(item for item in manifest.artifacts if item.logical_name == "lyricsSync")
        previous = decode_document(self._projects.read_working_text(working, lyrics.relative_path))
        if (previous.duration, _notes(previous)) == (document.duration, _notes(document)):
            return manifest
        old = next((item for item in manifest.artifacts if item.logical_name == "melody"), None)
        relative = old.relative_path.with_suffix(".flac") if old else Path("audio/melody.flac")
        target = self._projects.working_path(working, relative)
        self._render(document, target, working.parent)
        if old is not None and old.relative_path != relative:
            self._projects.working_path(working, old.relative_path).unlink(missing_ok=True)
        artifact = (
            replace(old, relative_path=relative, checksum=self._hasher(target))
            if old
            else ProjectArtifact(
                "melody", relative, ArtifactCategory.PORTABLE, self._hasher(target)
            )
        )
        artifacts = tuple(
            artifact if item.logical_name == "melody" else item for item in manifest.artifacts
        )
        return replace(manifest, artifacts=artifacts if old else (*artifacts, artifact))

    def _render(self, document: LyricsDocument, target: Path, parent: Path) -> None:
        # Editor revisions share files with their predecessors. Never write into a cloned link.
        with TemporaryDirectory(prefix="editor-melody-", dir=parent) as directory:
            wave = self._renderer.run(document, Path(directory))
            encoded = compress_audio(wave, self._processes, threading.Event())
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(encoded, target)


def _notes(document: LyricsDocument) -> tuple[tuple[int, float, float], ...]:
    # These are exactly the inputs used by RenderMelodyReference; text/letters/key do not alter it.
    return tuple(
        (note.note, note.start, note.end) for word in document.words for note in word.notes
    )
