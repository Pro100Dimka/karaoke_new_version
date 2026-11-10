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
