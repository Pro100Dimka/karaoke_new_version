from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from backend.lyrics.domain import LyricsDocument

_SAMPLE_RATE_HZ = 44100
_CHANNELS = 2
_FADE_SECONDS = 0.008
_PEAK_AMPLITUDE = 0.5


class RenderMelodyReference:
    """Synthesizes a listen-only audio rendering of a document's own notes, so the melody the pipeline
    extracted can be heard by ear the same way the reference vocal already can. AudioService mixes the
    result in as a monitor-only source (never the performance-mix recording tap), so the timbre only
    needs to carry pitch clearly, not sound musical."""

    def run(self, document: LyricsDocument, workspace: Path) -> Path:
        total_frames = max(1, round(document.duration * _SAMPLE_RATE_HZ))
        mix = np.zeros(total_frames, dtype=np.float32)
        for word in document.words:
            for note in word.notes:
                _add_note(mix, note.note, note.start, note.end)
        target = workspace / "melody.wav"
        _write_wave(target, mix)
        return target


def _add_note(mix: np.ndarray, midi_note: int, start_seconds: float, end_seconds: float) -> None:
    start_frame = round(start_seconds * _SAMPLE_RATE_HZ)
    end_frame = min(len(mix), round(end_seconds * _SAMPLE_RATE_HZ))
    frame_count = end_frame - start_frame
    if frame_count <= 0:
        return
    frequency_hz = 440.0 * (2.0 ** ((midi_note - 69) / 12.0))
    time_seconds = np.arange(frame_count, dtype=np.float32) / _SAMPLE_RATE_HZ
    tone = np.sin(2.0 * np.pi * frequency_hz * time_seconds).astype(np.float32)
    # A hard note-boundary edge clicks; a short linear fade at each end makes consecutive notes audible
    # as distinct pitches instead of one continuous buzz.
    fade_frames = min(round(_FADE_SECONDS * _SAMPLE_RATE_HZ), frame_count // 2)
    if fade_frames > 0:
        envelope = np.ones(frame_count, dtype=np.float32)
        ramp = np.linspace(0.0, 1.0, fade_frames, dtype=np.float32)
        envelope[:fade_frames] = ramp
        envelope[-fade_frames:] = ramp[::-1]
        tone *= envelope
    mix[start_frame:end_frame] += tone * _PEAK_AMPLITUDE


def _write_wave(target: Path, mix: np.ndarray) -> None:
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    normalized = mix / peak if peak > 1.0 else mix
    stereo = np.repeat(normalized.reshape(-1, 1), _CHANNELS, axis=1)
    pcm = np.clip(stereo * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(str(target), "wb") as audio:
        audio.setnchannels(_CHANNELS)
        audio.setsampwidth(2)
        audio.setframerate(_SAMPLE_RATE_HZ)
        audio.writeframes(pcm.tobytes())
