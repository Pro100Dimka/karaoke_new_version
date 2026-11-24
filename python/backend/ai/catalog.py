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

# Whisper large-v3-turbo (multilingual): coverage of sung phrases and word timestamps.
SPEECH_MODEL = ModelSpec(
    model_id="whisper-large-v3-turbo",
    purpose=AiCapability.ASR,
    version="aff26ae4",
    size=1_617_941_637,
    checksum="aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a",
    download_url=(
        "https://openaipublic.azureedge.net/main/whisper/models/"
        "aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a/large-v3-turbo.pt"
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

# Phoneme-informed note onsets, offsets and sung activity (MIT-licensed checkpoint).
NOTE_MODEL = ModelSpec(
    model_id="phoneme-note-boundaries",
    purpose=AiCapability.PITCH,
    version="b2fcd9ea",
    size=106_129_108,
    checksum="e56d1c7438f10afb61bbfe54a856a0355d4556fca6038dc67567fe68930ade17",
    download_url=(
        "https://media.githubusercontent.com/media/seyong92/"
        "phoneme-informed-note-level-singing-transcription/"
        "b2fcd9ea0f7898a8989c7e65781052d1ffc81094/checkpoints/model.pt"
    ),
)

CATALOG: tuple[ModelSpec, ...] = (SEPARATION_MODEL, SPEECH_MODEL, ALIGNMENT_MODEL, NOTE_MODEL)
