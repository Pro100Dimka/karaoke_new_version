from __future__ import annotations

from types import MappingProxyType
import os

import torch

# Language values of backend.songs.domain.Language mapped to Whisper language codes (None = auto-detect).
WHISPER_LANGUAGES = MappingProxyType(
    {"Auto": None, "Ukrainian": "uk", "Russian": "ru", "English": "en"}
)


def device() -> str:
    selected = os.environ.get("AD_VOICE_COMPUTE_DEVICE", "cpu")
    if selected not in {"cpu", "cuda"}:
        raise ValueError("Unsupported AI execution device")
    if selected == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("The admitted CUDA device is unavailable")
    return selected
