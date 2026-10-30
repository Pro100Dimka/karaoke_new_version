from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from types import MappingProxyType
from pathlib import Path
import hashlib
import os
import shutil

import torch

from backend.serialization import dumps, loads_object

# Language values of backend.songs.domain.Language mapped to Whisper language codes (None = auto-detect).
WHISPER_LANGUAGES = MappingProxyType(
    {"Auto": None, "Ukrainian": "uk", "Russian": "ru", "English": "en"}
)


@contextmanager
def cached_encoder(
    encoder: torch.nn.Module, *, reuse: AlignmentReuse | None = None
) -> Iterator[None]:
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
        features = forward(mel) if reuse is None else reuse.encoding(mel, forward)
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


class AlignmentReuse:
    """Intermediate results scoped to one job's disposable workspace."""

    def __init__(self, directory: Path, reserve_bytes: int) -> None:
        self._directory = directory
        self._reserve = reserve_bytes
        directory.mkdir(parents=True, exist_ok=True)

    def _path(self, key: bytes, suffix: str) -> Path:
        configuration = repr((device(), cpu_threads())).encode()
        return self._directory / (hashlib.sha256(configuration + key).hexdigest() + suffix)

    def _can_write(self, size: int) -> bool:
        return shutil.disk_usage(self._directory).free >= self._reserve + size + 4096

    def encoding(
        self, mel: torch.Tensor, forward: Callable[[torch.Tensor], torch.Tensor]
    ) -> torch.Tensor:
        key = repr((mel.dtype, tuple(mel.shape))).encode()
        key += mel.detach().cpu().contiguous().view(torch.uint8).numpy().tobytes()
        return self.tensor(b"encoder:" + key, lambda: forward(mel)).to(mel.device)

    def tensor(self, key: bytes, calculate: Callable[[], torch.Tensor]) -> torch.Tensor:
        path = self._path(key, ".pt")
        if path.is_file():
            value = torch.load(path, map_location="cpu", weights_only=True)
            if not isinstance(value, torch.Tensor):
                raise ValueError("Alignment features are malformed")
            return value
        result = calculate()
        if self._can_write(result.numel() * result.element_size()):
            torch.save(result.detach().cpu(), path)
        return result

    def context(
        self, key: bytes, calculate: Callable[[], Mapping[str, object]]
    ) -> Mapping[str, object]:
        path = self._path(key, ".json")
        if path.is_file():
            return loads_object(path.read_text(encoding="utf-8"))
        result = calculate()
        payload = dumps(result).encode("utf-8")
        if self._can_write(len(payload)):
            path.write_bytes(payload)
        return result


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
