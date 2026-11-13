from pathlib import Path
import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_quality import inspect_master


def test_streaming_master_qc(tmp_path: Path):
    path = tmp_path / "master.wav"
    t = np.arange(48000) / 48000
    sf.write(path, np.sin(2 * np.pi * 440 * t)[:, None] * 0.2, 48000)
    result = inspect_master(
        path, expected_frames=48000, expected_rate=48000, expected_channels=1, blocksize=1024
    )
    assert result["verified"] is True
    assert result["clippedSamples"] == 0
    assert -17.1 < result["rmsDbfs"] < -16.9


def test_rejects_silence(tmp_path: Path):
    path = tmp_path / "silent.wav"
    sf.write(path, np.zeros(1000), 48000)
    with pytest.raises(DependencyError):
        inspect_master(path, expected_frames=1000, expected_rate=48000, expected_channels=1)


def test_rejects_changed_duration(tmp_path: Path):
    path = tmp_path / "master.wav"
    sf.write(path, np.ones(1000) * 0.1, 48000)
    with pytest.raises(DependencyError):
        inspect_master(path, expected_frames=1001, expected_rate=48000, expected_channels=1)
