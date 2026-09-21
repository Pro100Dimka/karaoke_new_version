from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Capabilities:
    can_import_songs: bool
    can_process_songs: bool
    can_separate: bool
    can_run_asr: bool
    can_run_alignment: bool
    can_analyze_pitch: bool
    can_analyze_recording: bool
    can_use_cuda: bool
    online_lyrics_available: bool
    package_import_available: bool
    package_export_available: bool
