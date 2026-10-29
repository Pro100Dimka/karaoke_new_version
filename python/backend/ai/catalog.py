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

# Independent original-mix evidence for conservative vocal bleed suppression.
VOCAL_PREPARATION_MODEL = ModelSpec(
    model_id="mel-band-roformer-vocals",
    purpose=AiCapability.SEPARATION,
    version="87201f4d",
    size=913_106_900,
    checksum="87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e",
    download_url="https://huggingface.co/KimberleyJSN/melbandroformer/resolve/main/MelBandRoformer.ckpt",
)

# Vocal reflection estimate, evaluated independently for each original channel.
REVERBERATION_MODEL = ModelSpec(
    model_id="mel-band-roformer-dereverb",
    purpose=AiCapability.SEPARATION,
    version="f099ee71",
    size=913_097_978,
    checksum="f099ee717eb57fb0ad5eb0e7c9ad6787c36168140b61ce2b158b90c2c4ecee79",
    download_url=(
        "https://huggingface.co/anvuew/dereverb_mel_band_roformer/resolve/"
        "cef05ad2b5b3145ea5c149d3ad5d1f8439b34d06/"
        "dereverb_mel_band_roformer_mono_anvuew_sdr_20.4029.ckpt"
    ),
)

# Frame-wise breath evidence, gated by independent speech/harmonic protection.
BREATH_MODEL = ModelSpec(
    model_id="respiro-en",
    purpose=AiCapability.SEPARATION,
    version="1f4a9b96",
    size=35_377_347,
    checksum="1f4a9b96f96645c480bf0e07b1e18cd68878ac0b4bb5dc920ad93f9b17df858a",
    download_url=(
        "https://raw.githubusercontent.com/ydqmkkx/Respiro-en/"
        "70e01c60c2f582c41092730680f2894ab24d6467/respiro-en.pt"
    ),
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

CATALOG: tuple[ModelSpec, ...] = (
    SEPARATION_MODEL,
    VOCAL_PREPARATION_MODEL,
    REVERBERATION_MODEL,
    BREATH_MODEL,
    SPEECH_MODEL,
    ALIGNMENT_MODEL,
)
