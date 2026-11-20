"""Dynamics request complete frame evidence without unused spectral summaries."""

from collections import Counter
from dataclasses import fields
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings import studio_adaptive_features as features
from tests.test_studio_voice_analysis_reuse import _inputs, _render


def test_insert_reports_only_measure_spectrum_for_subtractive_inputs(tmp_path, monkeypatch):
    paths = _inputs(tmp_path)
    render = _render(tmp_path, paths)
    original, calls = features._spectral_summary, Counter()

    def summary(path, *args):
        calls[path] += 1
        return original(path, *args)

    monkeypatch.setattr(features, "_spectral_summary", summary)
    render._prepare_voice()
    edited = render.vocal
    render._finish_voice()
    assert calls == Counter({paths[0]: 1, paths[2]: 1, edited: 1}), (
        "Every insert still needs frame evidence, but only subtractive inputs need a spectrum"
    )


@pytest.mark.parametrize("rate,channels", [(8000, 1), (16000, 2), (48000, 4)])
def test_frame_features_keep_all_twelve_fields_and_uncertain_tail_reports(
    tmp_path, monkeypatch, rate, channels
):
    time = np.arange(round(rate * 3.153)) / rate
    amplitude = np.where(time < 1.0, 0.08, np.where(time < 2.5, 0.0002, 0.0))
    tone = amplitude * np.sin(2 * np.pi * 220 * time)
    samples = tone[:, None] * np.linspace(1.0, 0.5, channels)[None, :]
    source = tmp_path / "voice.wav"
    sf.write(source, samples, rate, subtype="DOUBLE")
    cancel = threading.Event()
    full = features.analyze_voice(source, cancel)

    def unused(*args, **kwargs):
        pytest.fail("Frame-only evidence must not calculate a spectral summary")

    monkeypatch.setattr(features, "_spectral_summary", unused)
    measured = features.analyze_frames(source, cancel)
    assert type(measured) is features.FrameFeatures
    assert isinstance(full, features.FrameFeatures)
    assert len(fields(measured)) == 12 and len(fields(full)) == 16
    assert not hasattr(measured, "spectrum_db") and not hasattr(measured, "low_edge_hz")
    for member in fields(measured):
        np.testing.assert_array_equal(getattr(measured, member.name), getattr(full, member.name))
    assert features.level_summary(measured) == features.level_summary(full)
    assert features.level_summary(measured)["uncertainPreservedSeconds"] > 1
    rebuilt = features.VoiceFeatures(*(getattr(full, member.name) for member in fields(full)))
    for member in fields(full):
        np.testing.assert_array_equal(getattr(rebuilt, member.name), getattr(full, member.name))
