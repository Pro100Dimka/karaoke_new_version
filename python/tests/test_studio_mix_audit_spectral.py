from pathlib import Path
import tempfile
import numpy as np
import soundfile as sf
from backend.recordings.studio_mix_audit import audit_mix


def test_voice_band_detects_backing_dominance():
    sr = 16000
    t = np.arange(sr * 2) / sr
    vocal = 0.1 * np.sin(2 * np.pi * 1000 * t)
    backing = 0.3 * np.sin(2 * np.pi * 1000 * t)
    with tempfile.TemporaryDirectory() as d:
        paths = [Path(d) / f"{name}.wav" for name in ("voice", "backing", "master")]
        for path, audio in zip(paths, (vocal, backing, vocal + backing)):
            sf.write(path, audio, sr)
        report = audit_mix(*paths, block_frames=4096)
        assert report["status"] == "measured"
        assert report["voiceBandBackingDominantFraction"] == 1.0
        assert report["voiceBandVocalToBackingMedianDb"] < -8


def test_incompatible_stems():
    with tempfile.TemporaryDirectory() as d:
        paths = [Path(d) / f"{i}.wav" for i in range(3)]
        for i, p in enumerate(paths):
            sf.write(p, np.zeros(1000 + i), 16000)
        assert audit_mix(*paths)["status"] == "incompatible-stems"
