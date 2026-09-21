from __future__ import annotations

from dataclasses import dataclass

from backend.ai.domain import AiCapability, RequiredModel


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """A model the built-in local provider needs, with everything required to download and verify it."""

    model_id: str
    purpose: AiCapability
    version: str
    size: int
    checksum: str
    download_url: str

    @property
    def required(self) -> RequiredModel:
        return RequiredModel(self.model_id, self.version, self.checksum)


# Hybrid Transformer Demucs: splits a song into vocals and accompaniment.
SEPARATION_MODEL = ModelSpec(
    model_id="htdemucs",
    purpose=AiCapability.SEPARATION,
    version="955717e8",
    size=84_141_911,
    checksum="8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4",
    download_url="https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th",
)

# Whisper "base" (multilingual): speech recognition and word timestamps for uk/ru/en.
SPEECH_MODEL = ModelSpec(
    model_id="whisper-base",
    purpose=AiCapability.ASR,
    version="ed3a0b6b",
    size=145_262_807,
    checksum="ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e",
    download_url=(
        "https://openaipublic.azureedge.net/main/whisper/models/"
        "ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e/base.pt"
    ),
)

# MMS forced aligner (multilingual, character-level CTC): times every word and letter of the lyrics against the vocal.
ALIGNMENT_MODEL = ModelSpec(
    model_id="mms-fa",
    purpose=AiCapability.ALIGNMENT,
    version="20ef1296",
    size=1_262_047_414,
    checksum="20ef12963ab4924bef49ac4fc7f58ad5da2ee43b2c11bc8c853c9b90ecdbc680",
    download_url="https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt",
)

CATALOG: tuple[ModelSpec, ...] = (SEPARATION_MODEL, SPEECH_MODEL, ALIGNMENT_MODEL)
