from __future__ import annotations

from backend.ai_worker.separation import _parallelism


def test_rhythm_uses_only_bass_kick_and_snare_not_melody_or_cymbals() -> None:
    import numpy as np
    import torch
    from backend.ai_worker.separation import _rhythm

    rate = 16000
    time = np.arange(rate * 3) / rate
    sources = torch.zeros((4, 2, len(time)))
    names = ["drums", "bass", "other", "vocals"]
    sources[2] = torch.tensor(np.sin(2 * np.pi * 440 * time) * 0.8)
    sources[3] = sources[2]
    sources[0] = torch.tensor(np.sin(2 * np.pi * 7000 * time) * 0.2)
    assert _rhythm(sources, names, rate) == []
    for index, frequency, at in [(0, 70, 0.5), (0, 800, 1.0), (1, 90, 2.0)]:
        envelope = np.where(time >= at, np.exp(-np.maximum(0, time - at) / 0.06), 0)
        sources[index] += torch.tensor(np.sin(2 * np.pi * frequency * time) * envelope * 0.5)
    beats = _rhythm(sources, names, rate)
    assert len(beats) == 3
    for expected in [0.5, 1.0, 2.0]:
        assert any(abs(moment - expected) < 0.04 and strength > 0.4 for moment, strength in beats)


def test_cpu_separation_derives_parallelism_from_the_admitted_thread_budget() -> None:
    workers, threads_per_worker = _parallelism("cpu", 16)

    assert workers == 4
    assert threads_per_worker == 4
    assert workers * threads_per_worker <= 16


def test_single_thread_and_cuda_separation_do_not_create_cpu_worker_pools() -> None:
    assert _parallelism("cpu", 1) == (0, 1)
    assert _parallelism("cuda", 16) == (0, 16)
