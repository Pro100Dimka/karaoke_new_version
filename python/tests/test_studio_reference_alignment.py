from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings.studio_reference import _reference_offset


def _write_pair(tmp_path: Path, actual: np.ndarray, expected: np.ndarray, rate: int):
    backing, reference = tmp_path / "backing.wav", tmp_path / "reference.wav"
    sf.write(backing, actual, rate, subtype="FLOAT")
    sf.write(reference, expected, rate, subtype="FLOAT")
    return backing, reference


@pytest.mark.parametrize("outlier", [False, True])
def test_reference_alignment_survives_unusable_intro(tmp_path: Path, outlier: bool):
    rate, delay = 4000, 12
    rng = np.random.default_rng(38)
    reference = rng.normal(0, 0.03, rate * 36)
    backing = np.r_[np.zeros(delay), reference[:-delay]] * 0.14
    # A changed separator intro cannot veto independent later evidence.
    backing[: rate * 4] = rng.normal(0, 0.004, rate * 4)
    if outlier:
        backing[rate * 16 : rate * 20] = reference[rate * 16 - 160 : rate * 20 - 160] * 0.14
    paths = _write_pair(tmp_path, backing, reference, rate)
    before = [path.read_bytes() for path in paths]
    offset, confidence = _reference_offset(*paths, 0.0, threading.Event())
    assert offset == pytest.approx(-delay / rate, abs=1 / rate)
    assert confidence > 0.99
    assert [path.read_bytes() for path in paths] == before


@pytest.mark.parametrize("case", ["periodic", "unrelated", "changing-delay"])
def test_reference_alignment_rejects_ambiguous_evidence(tmp_path: Path, case: str):
    rate, delay = 4000, 12
    rng = np.random.default_rng(53)
    reference = rng.normal(0, 0.03, rate * 36)
    if case == "periodic":
        reference = 0.03 * np.sin(2 * np.pi * 220 * np.arange(len(reference)) / rate)
    backing = np.r_[np.zeros(delay), reference[:-delay]]
    if case == "unrelated":
        backing = rng.normal(0, 0.03, len(reference))
    if case == "changing-delay":
        boundary, changed = len(backing) // 2, 132
        backing[boundary:] = reference[boundary - changed : len(reference) - changed]
    paths = _write_pair(tmp_path, backing, reference, rate)
    assert _reference_offset(*paths, 0.0, threading.Event()) == (0.0, 0.0)


def test_short_reference_alignment_requires_independent_windows(tmp_path: Path):
    rate, delay = 4000, 12
    rng = np.random.default_rng(56)
    reference = rng.normal(0, 0.03, rate * 8)
    backing = rng.normal(0, 0.03, len(reference))
    # Re-sampling overlapping windows must not turn four seconds into six.
    backing[rate * 2 : rate * 6] = reference[rate * 2 - delay : rate * 6 - delay]
    paths = _write_pair(tmp_path, backing, reference, rate)
    assert _reference_offset(*paths, 0.0, threading.Event()) == (0.0, 0.0)
