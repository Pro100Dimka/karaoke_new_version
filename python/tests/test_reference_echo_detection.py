"""Known-echo and no-echo regression tests for reference delay estimation."""
import numpy as np
import pytest
from scipy.signal import butter, sosfilt
from backend.recordings.studio_space import _cepstrum, _delay

@pytest.mark.parametrize('delay', [None, 0.085, 0.235, 0.42])
def test_delay_detector_does_not_invent_and_recovers_known_delay(delay):
    rng = np.random.default_rng(3)
    rate = 8000
    clean = sosfilt(butter(3, [180, 2700], btype='bandpass', fs=rate, output='sos'),
                   rng.standard_normal(rate * 20))
    clean *= np.repeat((rng.random(1000) > 0.35).astype(float), 160)
    processed = clean.copy()
    if delay is not None:
        offset = round(delay * rate)
        processed[offset:] += 0.35 * clean[:-offset]
    frames = np.array([_cepstrum(processed[i:i + 2 * rate, None], rate)
                       for i in range(0, len(processed) - 2 * rate + 1, 2 * rate)])
    detected, gain, support = _delay(frames)
    if delay is None:
        assert detected == 0 and gain == 0
    else:
        assert abs(detected - delay) < 0.002
        assert gain > 0 and support >= 0.7
