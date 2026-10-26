from __future__ import annotations

import soundfile as sf
from pathlib import Path

from backend.domain_errors import DomainError
from backend.recordings.ports import RecordingFileMetadata


class WaveRecordingInspector:
    def inspect(self, path: Path) -> RecordingFileMetadata:
        try:
            audio = sf.info(path)
            rate, channels, frames = audio.samplerate, audio.channels, audio.frames
        except (OSError, RuntimeError) as exc:
            raise DomainError("InvalidRecording", "Recording audio cannot be read", 400) from exc
        if rate <= 0 or channels <= 0 or frames <= 0:
            raise DomainError("InvalidRecording", "Recording audio metadata is invalid", 400)
        return RecordingFileMetadata(frames / rate, rate, channels)
