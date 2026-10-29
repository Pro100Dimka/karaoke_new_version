from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Mapping, Sequence


class AiCapability(StrEnum):
    SEPARATION = "Separation"
    ASR = "ASR"
    PITCH = "Pitch"
    ALIGNMENT = "Alignment"


@dataclass(frozen=True, slots=True)
class RequiredModel:
    model_id: str
    version: str
    checksum: str


@dataclass(frozen=True, slots=True)
class AiProviderDescriptor:
    provider_id: str
    version: str
    capabilities: frozenset[AiCapability]
    supported_languages: frozenset[str]
    required_models: Sequence[RequiredModel]
    required_resources: Mapping[str, int | float | str]


@dataclass(frozen=True, slots=True)
class WordTiming:
    text: str
    start: float
    end: float
    confidence: float
    # Start time of every character of ``text`` (empty when the aligner could not time letters).
    letters: tuple[float, ...] = ()
    diagnostics: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class PitchPoint:
    time: float
    frequency: float
    confidence: float
    # Independent vocal-track loudness evidence; None for providers without an audio envelope.
    # Audible backing bleed/reverb can also be active, so this does not certify sung voice.
    audio_active: bool | None = None


@dataclass(frozen=True, slots=True)
class SeparatedAudio:
    instrumental: Path
    reference_vocal: Path
    rhythm: tuple[tuple[float, float], ...] = ()
    raw_vocal: Path | None = None
    preparation: Mapping[str, object] = field(default_factory=dict)
