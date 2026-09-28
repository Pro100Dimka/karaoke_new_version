"""Measures voice lags in room-sync-probe recordings.

Client A plays the instrumental plus the reference vocal as a guide and captures its own output as
its "voice". A saved performance never contains the guide, so in any recording the reference vocal
appears only inside A's captured voice. Its position against the recording's own instrumental is the
lag between the music and that voice:
  B.wav: lag a listener hears between the music and a remote singer.
  A.wav: lag of the singer's own voice in the saved performance.

Usage: python room-sync-analyze.py <probe-dir> <song-audio-dir> [start-second]
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import correlate, find_peaks, resample_poly

RATE = 48000
WINDOW_SECONDS = 3
VOICE_SEARCH_SECONDS = 0.5


def mono(path):
    data, source_rate = sf.read(path, always_2d=True, dtype="float64")
    data = data.mean(axis=1)
    return resample_poly(data, RATE, source_rate) if source_rate != RATE else data


def normalized_positions(reference, segment, lo, hi):
    """Normalized cross-correlation of segment against reference[lo:hi]; returns (offsets, ncc)."""
    lo = max(0, lo)
    window = reference[lo: hi + len(segment)]
    corr = correlate(window, segment, mode="valid", method="fft")
    energy = np.concatenate([[0.0], np.cumsum(window ** 2)])
    local = energy[len(segment):] - energy[: -len(segment)]
    ncc = corr / np.sqrt(local * np.sum(segment ** 2) + 1e-12)
    return lo + np.arange(len(ncc)), ncc


def analyse(recording, inst, vocal, song_start):
    lags = []
    active = np.flatnonzero(np.abs(recording) > 1e-3)
    first = int(active[0]) if active.size else 0
    for index in range(0, (len(recording) - first) // RATE - WINDOW_SECONDS, WINDOW_SECONDS):
        begin = first + RATE // 2 + index * RATE
        segment = recording[begin: begin + WINDOW_SECONDS * RATE]
        if len(segment) < WINDOW_SECONDS * RATE:
            break
        expected = song_start + (begin - first)
        offsets, ncc = normalized_positions(inst, segment, expected - 3 * RATE, expected + 3 * RATE)
        # With the burst markers (room-sync-markers.py) each signal has one sharp peak. A captured
        # copy of the music is always older than the recording's own music, so among strong matches
        # the latest one is the own music.
        peaks, _ = find_peaks(ncc, height=0.2 * float(ncc.max()), distance=int(0.003 * RATE))
        own = int(offsets[int(max(peaks))]) if len(peaks) else int(offsets[int(np.argmax(ncc))])
        vs = int(VOICE_SEARCH_SECONDS * RATE)
        voffsets, vncc = normalized_positions(vocal, segment, own - vs, own + int(0.01 * RATE))
        voice = int(voffsets[int(np.argmax(vncc))])
        lags.append({"lagMs": round((own - voice) / RATE * 1000, 1),
                     "music": round(float(ncc.max()), 3), "voice": round(float(vncc.max()), 3)})
    return lags


def main():
    out_dir, song_dir = Path(sys.argv[1]), Path(sys.argv[2])
    start = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
    inst = mono(song_dir / "instrumental.wav")
    vocal = mono(song_dir / "reference-vocal.wav")
    result = {}
    for name in ("A", "B"):
        lags = analyse(mono(out_dir / f"{name}.wav"), inst, vocal, int(start * RATE))
        values = [item["lagMs"] for item in lags if item["voice"] > 0.015]
        result[name] = {"windows": lags,
                        "medianLagMs": float(np.median(values)) if values else None}
    print(json.dumps(result, indent=1))
    (out_dir / "analysis.json").write_text(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
