from __future__ import annotations

from types import MappingProxyType

import torch

# Language values of backend.songs.domain.Language mapped to Whisper language codes (None = auto-detect).
WHISPER_LANGUAGES = MappingProxyType(
    {"Auto": None, "Ukrainian": "uk", "Russian": "ru", "English": "en"}
)


def device() -> str:
    return "cuda" if torch.cuda.is_available() else "cpu"
