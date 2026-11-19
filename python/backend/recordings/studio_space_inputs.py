"""Reference identity and capture-analysis evidence for one spatial render."""

from dataclasses import asdict
from pathlib import Path
import threading

import numpy as np
import soundfile as sf

from backend.recordings.studio_audio import _check_cancel
from backend.recordings.studio_space_analysis import SpaceProfile


def recorded_space_report(profile: SpaceProfile | None) -> dict[str, object]:
    return {
        "recorded": asdict(profile) if profile is not None else None,
        "recordedAnalysis": "measured" if profile is not None else "dry-capture-not-measured",
        "existingEffectsPolicy": "estimated-wet-stem" if profile is not None else "dry-capture",
    }


def same_reference_pcm(first: Path, second: Path, cancel: threading.Event) -> bool:
    _check_cancel(cancel)
    if first == second:
        return True
    with sf.SoundFile(first) as original, sf.SoundFile(second) as scoped:
        if (original.frames, original.samplerate, original.channels) != (
            scoped.frames,
            scoped.samplerate,
            scoped.channels,
        ):
            return False
        while True:
            _check_cancel(cancel)
            expected = original.read(65536, dtype="float64", always_2d=True)
            if not len(expected):
                return True
            actual = scoped.read(len(expected), dtype="float64", always_2d=True)
            _check_cancel(cancel)
            if not np.array_equal(expected, actual):
                return False
