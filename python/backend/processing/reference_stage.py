from __future__ import annotations

from pathlib import Path

from backend.projects.ports import AudioFileValidator


class PrepareReferenceVocal:
    def __init__(self, audio: AudioFileValidator) -> None:
        self._audio = audio

    def run(self, reference_vocal: Path) -> Path:
        self._audio.validate(reference_vocal)
        return reference_vocal
