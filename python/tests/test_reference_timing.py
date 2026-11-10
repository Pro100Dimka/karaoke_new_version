import numpy as np
from backend.recordings.studio_dynamics import _reference_compressor_timing, _reference_compression


def test_phrase_envelope():
    phrase = np.r_[
        np.full(10, -60.0), np.linspace(-50, -18, 8), np.full(10, -18.0), np.linspace(-18, -50, 12)
    ]
    result = _reference_compressor_timing(np.tile(phrase, 5))
    assert result["timingMethod"] == "reference-phrase-envelope"
    assert 5 <= result["attackMs"] <= 100
    assert 50 <= result["releaseMs"] <= 1000


def test_no_evidence():
    assert (
        _reference_compressor_timing(np.full(100, -20.0))["timingMethod"] == "insufficient-contrast"
    )


def test_compression_has_timing():
    x = np.tile(
        np.r_[
            np.full(10, -60.0),
            np.linspace(-50, -18, 8),
            np.full(10, -18.0),
            np.linspace(-18, -50, 12),
        ],
        5,
    )
    assert "attackMs" in _reference_compression(x + 3, x)
