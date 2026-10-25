from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from types import MappingProxyType
import os

import torch

# Language values of backend.songs.domain.Language mapped to Whisper language codes (None = auto-detect).
WHISPER_LANGUAGES = MappingProxyType(
    {"Auto": None, "Ukrainian": "uk", "Russian": "ru", "English": "en"}
)


@contextmanager
def cached_encoder(encoder: torch.nn.Module) -> Iterator[None]:
    """Reuse one immutable audio encoding between Whisper decoding and word timing."""
    forward: Callable[[torch.Tensor], torch.Tensor] = encoder.forward
    overridden = "forward" in vars(encoder)
    cached: tuple[torch.Tensor, torch.Tensor] | None = None

    def encode(mel: torch.Tensor) -> torch.Tensor:
        nonlocal cached
        if torch.is_grad_enabled():
            return forward(mel)
        if cached is not None:
            source, features = cached
            if (
                source.dtype == mel.dtype
                and source.device == mel.device
                and torch.equal(source, mel)
            ):
                return features
        features = forward(mel)
        # Copy the input so in-place changes or recycled storage cannot produce a stale hit.
        cached = mel.clone(), features
        return features

    encoder.forward = encode
    try:
        yield
    finally:
        if overridden:
            encoder.forward = forward
        else:
            del encoder.forward


def device() -> str:
    selected = os.environ.get("AD_VOICE_COMPUTE_DEVICE", "cpu")
    if selected not in {"cpu", "cuda"}:
        raise ValueError("Unsupported AI execution device")
    if selected == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("The admitted CUDA device is unavailable")
    return selected


def cpu_threads() -> int:
    value = os.environ.get("OMP_NUM_THREADS")
    try:
        return max(1, int(value)) if value else max(1, torch.get_num_threads())
    except ValueError:
        return max(1, torch.get_num_threads())
