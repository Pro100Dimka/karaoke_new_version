import threading
import numpy as np
import soundfile as sf
from backend.recordings.studio_spectrum import _unmask_backing


def test_reference_driven_masking_uses_song_specific_spectral_target(tmp_path):
    sr = 48000
    t = np.arange(sr, dtype=np.float32) / sr
    tone = np.sin(2 * np.pi * 1000 * t).astype(np.float32)
    for name, gain in [
        ("reference-vocal", 0.25),
        ("reference-backing", 0.1),
        ("voice", 0.1),
        ("backing", 0.25),
    ]:
        sf.write(tmp_path / f"{name}.wav", tone * gain, sr, subtype="FLOAT")
    report = _unmask_backing(
        tmp_path / "backing.wav",
        tmp_path / "voice.wav",
        tmp_path / "out.wav",
        np.ones(10, dtype=bool),
        threading.Event(),
        tmp_path / "reference-vocal.wav",
        tmp_path / "reference-backing.wav",
    )
    assert report["referenceBandTargetsDb"] is not None
    assert report["affectedFraction"] > 0
    result, _ = sf.read(tmp_path / "out.wav", dtype="float32")
    assert np.isfinite(result).all()
    assert len(result) == len(t)


def test_masking_uses_actual_voice_and_music_without_an_original(tmp_path):
    rate = 8000
    time = np.arange(rate) / rate
    tone = np.sin(2 * np.pi * 1000 * time)
    for name, gain in [("voice", 0.05), ("backing", 0.2)]:
        sf.write(tmp_path / f"{name}.wav", tone * gain, rate, subtype="FLOAT")
    report = _unmask_backing(
        tmp_path / "backing.wav",
        tmp_path / "voice.wav",
        tmp_path / "out.wav",
        np.ones(10, dtype=bool),
        threading.Event(),
    )
    output, actual_rate = sf.read(tmp_path / "out.wav")
    assert actual_rate == rate and len(output) == len(tone)
    assert report["referenceBandTargetsDb"] is None
    assert 0 < max(report["maxReductionDb"]) <= 1.5
    assert np.mean(output**2) < np.mean((tone * 0.2) ** 2)
