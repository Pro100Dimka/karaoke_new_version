from __future__ import annotations

import shutil
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Mapping, Sequence

from backend.ai.domain import (
    AiCapability,
    AiProviderDescriptor,
    PitchPoint,
    RequiredModel,
    SeparatedAudio,
    WordTiming,
)
from backend.domain_errors import DependencyError
from backend.lyrics.ports import LyricsCandidate
from backend.songs.domain import Language, Song


class FakeAiProvider:
    def __init__(
        self,
        provider_id: str = "fake-ai",
        required_resources: Mapping[str, int | float | str] | None = None,
        required_models: Sequence[RequiredModel] = (),
    ) -> None:
        self._descriptor = AiProviderDescriptor(
            provider_id=provider_id,
            version="1",
            capabilities=frozenset(AiCapability),
            supported_languages=frozenset(item.value for item in Language),
            required_models=tuple(required_models),
            required_resources=required_resources or {"cpuThreads": 1},
        )

    @property
    def descriptor(self) -> AiProviderDescriptor:
        return self._descriptor

    def separate(
        self,
        audio: Path,
        workdir: Path,
        cancel: threading.Event,
    ) -> SeparatedAudio:
        if cancel.is_set():
            raise DependencyError("ProviderCancelled", "cancelled")
        workdir.mkdir(parents=True, exist_ok=True)
        instrumental = workdir / "instrumental.wav"
        vocal = workdir / "reference-vocal.wav"
        shutil.copy2(audio, instrumental)
        shutil.copy2(audio, vocal)
        return SeparatedAudio(instrumental, vocal)

    def transcribe(self, vocal: Path, language: Language, cancel: threading.Event) -> str:
        del vocal, language
        if cancel.is_set():
            raise DependencyError("ProviderCancelled", "cancelled")
        return "la"

    def align(
        self,
        vocal: Path,
        lyrics: str,
        language: Language,
        cancel: threading.Event,
    ) -> Sequence[WordTiming]:
        del vocal, language
        if cancel.is_set():
            raise DependencyError("ProviderCancelled", "cancelled")
        text = lyrics.strip() or "la"
        return (WordTiming(text, 0.05, 0.95, 0.99),)

    def pitch(self, vocal: Path, cancel: threading.Event) -> Sequence[PitchPoint]:
        del vocal
        if cancel.is_set():
            raise DependencyError("ProviderCancelled", "cancelled")
        return tuple(PitchPoint(index / 100, 440.0, 0.99) for index in range(10, 91, 5))


class FakeClock:
    def __init__(self, value: datetime | None = None) -> None:
        self.value = value or datetime(2026, 1, 1, tzinfo=UTC)

    def now(self) -> datetime:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += timedelta(seconds=seconds)


class FakeWaiter:
    def __init__(self) -> None:
        self.delays: list[float] = []

    def wait(self, seconds: float, cancel: threading.Event) -> bool:
        self.delays.append(seconds)
        return cancel.is_set()


@dataclass
class FakeLyricsProvider:
    outcomes: list[Sequence[LyricsCandidate] | DependencyError]
    provider_id: str = "fake-lyrics"

    def search(
        self,
        song: Song,
        language: Language,
        cancel: threading.Event,
    ) -> Sequence[LyricsCandidate]:
        del song, language, cancel
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, DependencyError):
            raise outcome
        return outcome
