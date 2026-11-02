"""Small source-review reproducer: continuous quiet glissando versus an actual release.

Uses a deterministic harmonic signal and the production acoustic functions only.
No model inference, label fitting or source edits.
"""
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import sys

import numpy as np

from backend.ai_worker import ctc
from backend.ai_worker.timing import _bridged, _runs, audible_frames, harmonic_evidence, voiced_frames


baseline_path = Path("/workspace/scratch/513dbcd967bf/baseline-v3/karaoke_new_version-refactor-frontend-direct/python/backend/ai_worker/ctc.py")
spec = importlib.util.spec_from_file_location("review_baseline_ctc", baseline_path)
baseline = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = baseline
spec.loader.exec_module(baseline)

rate = 16000
axis = np.arange(4 * rate) / rate
results = []
for upper in (220, 660):
    frequency = np.full(len(axis), 220.0)
    dip = (axis >= 1.8) & (axis < 1.89)
    frequency[dip] = np.linspace(220, upper, int(dip.sum()))
    frequency[axis >= 1.89] = upper
    phase = 2 * np.pi * np.cumsum(frequency) / rate
    amplitude = np.where((axis >= 1) & (axis < 3), 0.2, 0.0)
    amplitude[dip] = 0.003
    audio = (amplitude * (np.sin(phase) + 0.25 * np.sin(2 * phase))).astype(np.float32)
    word = ctc.AlignedWord("ма", 1, 1.5, (1, 1.4), 0.9)
    period = harmonic_evidence(audio, rate, 160)[1]
    active = voiced_frames(audio, rate, 160)
    unbridged = _bridged(audible_frames(audio, 160), 5)
    gaps = []
    for first, last in _runs(unbridged, False):
        if not 0 < first < last < len(unbridged):
            continue
        gap = audio[first * 160:last * 160]
        spectrum = np.fft.rfft(gap - gap.mean(), n=2 * len(gap))
        correlation = np.fft.irfft(np.abs(spectrum) ** 2, n=2 * len(gap))
        support = correlation[round(rate / 1100):round(rate / 65)].max()
        gaps.append({
            "start": first / 100,
            "end": last / 100,
            "strictPeriodicSupport": float(support / max(float(correlation[0]), 1e-12)),
            "existingFramePeriodicityMedian": float(np.median(period[first:last])),
            "existingActivityAll": bool(active[first:last].all()),
        })
    results.append({
        "initialHz": 220,
        "finalHz": upper,
        "continuousSingingInterval": [1, 3],
        "quietGlideInterval": [1.8, 1.89],
        "quietAmplitude": 0.003,
        "normalAmplitude": 0.2,
        "baselineEnd": baseline.with_sung_ends([word], audio)[0].end,
        "currentEnd": ctc.with_sung_ends([word], audio)[0].end,
        "gaps": gaps,
        "audioSha256": sha256(audio.tobytes()).hexdigest(),
    })
document = {
    "baselineCtcSha256": sha256(baseline_path.read_bytes()).hexdigest(),
    "currentCtcSha256": sha256(Path(ctc.__file__).read_bytes()).hexdigest(),
    "cases": results,
    "limitation": "Synthetic signal demonstrates algorithmic behavior; not a claim about measured errors in the frozen recordings.",
}
Path(__file__).with_suffix(".json").write_text(json.dumps(document, indent=2))
print(json.dumps(document, indent=2))
