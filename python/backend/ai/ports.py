from __future__ import annotations

import threading
from pathlib import Path
from typing import Protocol, Sequence

from backend.ai.domain import AiProviderDescriptor, PitchPoint, SeparatedAudio, WordTiming
from backend.songs.domain import Language


class AiProvider(Protocol):
    @property
    def descriptor(self) -> AiProviderDescriptor: ...

    def separate(self, audio: Path, workdir: Path, cancel: threading.Event) -> SeparatedAudio: ...

    def transcribe(self, vocal: Path, language: Language, cancel: threading.Event) -> str: ...

    def align(
        self, vocal: Path, lyrics: str, language: Language, cancel: threading.Event
    ) -> Sequence[WordTiming]: ...

    def pitch(self, vocal: Path, cancel: threading.Event) -> Sequence[PitchPoint]: ...
