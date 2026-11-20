"""Reuse immutable voice measurements only within one master render."""

from __future__ import annotations

from dataclasses import dataclass, field, fields
from pathlib import Path
import threading

import numpy as np

from backend.domain_errors import DependencyError
from backend.recordings.studio_adaptive_features import VoiceFeatures, analyze_voice
from backend.recordings.studio_audio import _check_cancel

FileIdentity = tuple[int, int, int, int, int]


def _identity(path: Path) -> FileIdentity:
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def _readonly(features: VoiceFeatures) -> VoiceFeatures:
    # Consumers may derive arrays, but cannot corrupt another stage's measurement.
    for member in fields(features):
        value = getattr(features, member.name)
        if isinstance(value, np.ndarray):
            value.setflags(write=False)
    return features


@dataclass(slots=True)
class VoiceAnalysisCache:
    _entries: dict[Path, tuple[FileIdentity, VoiceFeatures]] = field(
        default_factory=dict, init=False, repr=False
    )

    def measure(self, path: Path, cancel: threading.Event) -> VoiceFeatures:
        _check_cancel(cancel)
        identity = _identity(path)
        entry = self._entries.get(path)
        if entry is not None and entry[0] == identity:
            return entry[1]
        measured = analyze_voice(path, cancel)
        _check_cancel(cancel)
        if _identity(path) != identity:
            raise DependencyError(
                "StudioMasterInvalidAudio", "Vocal source changed during analysis"
            )
        self._entries[path] = identity, _readonly(measured)
        return measured
