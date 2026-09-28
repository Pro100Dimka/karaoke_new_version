"""Writes two unambiguous timing signals for room-sync-probe.

instrumental.wav ("music") and reference-vocal.wav ("the singer's guide") are independent sparse
trains of short noise bursts at random intervals. Unlike real music they have no repeating beat,
so a cross-correlation has one sharp peak and a lag can be read to a fraction of a millisecond.

Usage: python room-sync-markers.py <out-dir> [seconds]
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

RATE = 48000
BURST_MS = 12


def burst_train(seconds, seed):
    rng = np.random.default_rng(seed)
    signal = np.zeros(int(seconds * RATE), dtype=np.float32)
    burst = int(BURST_MS * RATE / 1000)
    window = np.hanning(burst).astype(np.float32)
    position = int(0.1 * RATE)
    while position + burst < len(signal):
        signal[position: position + burst] += rng.standard_normal(burst).astype(np.float32) * window * 0.5
        position += int(rng.uniform(0.12, 0.45) * RATE)
    return signal


def main():
    out = Path(sys.argv[1])
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 120.0
    out.mkdir(parents=True, exist_ok=True)
    sf.write(out / "instrumental.wav", burst_train(seconds, 1), RATE, subtype="FLOAT")
    sf.write(out / "reference-vocal.wav", burst_train(seconds, 2), RATE, subtype="FLOAT")
    print(out)


if __name__ == "__main__":
    main()
