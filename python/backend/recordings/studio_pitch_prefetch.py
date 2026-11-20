"""Own speculative reference pitch only for the lifetime of one master render."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
import threading

from backend.ai.domain import PitchPoint
from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import _check_cancel
from backend.recordings.studio_parallel import ScheduledMap
from backend.recordings.studio_pitch import PitchAnalyzer
from backend.recordings.studio_pitch_analysis import prefetch_pitch

SourceIdentity = tuple[int, int, int, int, int]


def _identity(path: Path) -> SourceIdentity:
    try:
        stat = path.stat()
    except OSError as error:
        raise DependencyError("StudioMasterInvalidAudio", "Pitch source is unavailable") from error
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def _verify_identity(path: Path, expected: SourceIdentity) -> None:
    if _identity(path) != expected:
        raise DependencyError("StudioMasterInvalidAudio", "Pitch source changed during analysis")


@dataclass(frozen=True, slots=True)
class _PendingPitch:
    path: Path
    identity: SourceIdentity
    chunks: ScheduledMap[int, list[PitchPoint]]


class LocalPitchAnalyzer:
    def __init__(self, cancel: threading.Event, fallback: PitchAnalyzer) -> None:
        self._cancel, self._fallback = cancel, fallback
        self._pending: _PendingPitch | None = None

    def prefetch(self, path: Path) -> None:
        self._ensure_active()
        if self._pending is not None and self._pending.path == path:
            self._validate_pending()
            return
        self.close()
        identity = _identity(path)
        pending = _PendingPitch(path, identity, prefetch_pitch(path, self._cancel))
        retained = False
        try:
            _verify_identity(path, identity)
            self._pending = pending
            retained = True
        finally:
            if not retained:
                pending.chunks.close()

    def _validate_pending(self) -> None:
        assert self._pending is not None
        valid = False
        try:
            _verify_identity(self._pending.path, self._pending.identity)
            valid = True
        finally:
            if not valid:
                self.close()

    def __call__(self, path: Path) -> Sequence[PitchPoint]:
        self._ensure_active()
        pending = self._pending
        if pending is None or path != pending.path:
            return self._call_fallback(path)
        self._pending = None
        try:
            _verify_identity(path, pending.identity)
            points = tuple(point for chunk in pending.chunks for point in chunk)
            _check_cancel(self._cancel)
            _verify_identity(path, pending.identity)
            return points
        finally:
            pending.chunks.close()

    def _call_fallback(self, path: Path) -> Sequence[PitchPoint]:
        completed = False
        try:
            points = self._fallback(path)
            self._ensure_active()
            completed = True
            return points
        finally:
            if not completed:
                self.close()

    def _ensure_active(self) -> None:
        if self._cancel.is_set():
            self.close()
        _check_cancel(self._cancel)

    def close(self) -> None:
        pending, self._pending = self._pending, None
        if pending is not None:
            pending.chunks.close()
