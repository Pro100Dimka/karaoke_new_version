import subprocess
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

from backend.recordings.studio_space import SpaceProfile, _render_separate_buses


class Renderer:
    def _mix(self, a, b, graph, output, cancel):
        subprocess.run(
            [
                "ffmpeg", "-nostdin", "-y", "-loglevel", "error",
                "-i", str(a), "-i", str(b), "-filter_complex", graph,
                "-map", "[out]", *output,
            ],
            check=True,
            timeout=25,
        )


def test_separate_buses_preserve_frames_and_apply_effects(tmp_path: Path) -> None:
    rate = 16000
    time = np.arange(rate * 2) / rate
    wave = 0.09 * np.sin(2 * np.pi * 220 * time)
    audio = np.column_stack([wave, wave]).astype("float32")
    audio[:rate // 5] = 0
    sf.write(tmp_path / "dry.wav", audio, rate, subtype="FLOAT")
    profile = SpaceProfile(
        delay_seconds=0.11, delay_gain=0.18, decay_seconds=0.55,
        reverb_gain=0.2, stereo_width=0.5, effect_type="slapback",
    )
    _render_separate_buses(
        Renderer(), tmp_path / "dry.wav", tmp_path / "out.wav",
        threading.Event(), profile,
    )
    output, output_rate = sf.read(tmp_path / "out.wav", always_2d=True)
    assert output_rate == rate
    assert output.shape == audio.shape
    assert np.isfinite(output).all()
    assert np.max(np.abs(output - audio)) > 1e-5
