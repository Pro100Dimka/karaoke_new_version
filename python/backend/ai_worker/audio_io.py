from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np
import soundfile as sf


def read_mono(path: Path, sample_rate: int) -> np.ndarray:
    """Mono float32 samples resampled to ``sample_rate``."""
    samples, _ = librosa.load(str(path), sr=sample_rate, mono=True)
    return samples.astype(np.float32, copy=False)


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    """``samples`` is channels x frames float32."""
    sf.write(str(path), samples.T, sample_rate, subtype="PCM_24")
