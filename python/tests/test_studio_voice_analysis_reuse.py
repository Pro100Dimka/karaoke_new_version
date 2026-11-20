"""A render may reuse measured PCM, but never a changed file or another render."""

from collections import Counter
from dataclasses import fields
import os
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings import studio_adaptive_features as features
from backend.recordings.studio_adaptive_voice import prepare_voice, process_voice
from backend.recordings.studio_arrangement import analyze_arrangement
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_render import MasterRender
from backend.recordings.studio_sources import MasterSources


def _inputs(folder, channels=1):
    rate = 8000
    time = np.arange(rate * 3 + 37) / rate
    active = (time >= 0.3) & (time < 2.7)
    voice = 0.05 * (1 + 0.3 * np.sin(2 * np.pi * time)) * np.sin(2 * np.pi * 220 * time)
    voice += 0.01 * np.sin(2 * np.pi * 1100 * time)
    music = 0.07 * np.sin(2 * np.pi * 130 * time)
    signals = (voice * active, music, voice * active * 1.7)
    paths = tuple(folder / f"{name}.wav" for name in ("voice", "music", "reference"))
    for path, signal in zip(paths, signals):
        samples = signal if channels == 1 else np.column_stack((signal, signal * 0.8))
        sf.write(path, samples, rate, subtype="FLOAT")
    return paths


def _render(folder, paths):
    voice, music, reference = paths
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    render = MasterRender(
        renderer,
        voice,
        music,
        reference,
        music,
        folder / "master.wav",
        threading.Event(),
        music,
        True,
        True,
        False,
        (),
        None,
    )
    render.work = folder / "stages"
    render.work.mkdir()
    info = sf.info(voice)
    render.sources = MasterSources(
        voice, music, reference, music, None, info.frames, info.samplerate, info.channels, {}
    )
    render.vocal, render.processing = voice, {}
    render.arrangement = analyze_arrangement(music, reference, render.cancel)
    return render


def _count_measurements(monkeypatch):
    calls = Counter()
    measure = features._measure_blocks

    def counted(path, cancel):
        calls[path] += 1
        return measure(path, cancel)

    monkeypatch.setattr(features, "_measure_blocks", counted)
    return calls


def _cache():
    from backend.recordings.studio_voice_analysis import VoiceAnalysisCache

    return VoiceAnalysisCache()


def _equal_features(actual, expected):
    for field in fields(actual):
        first, second = getattr(actual, field.name), getattr(expected, field.name)
        if isinstance(first, np.ndarray):
            np.testing.assert_array_equal(first, second)
        else:
            assert first == second


def test_master_render_measures_unchanged_reference_and_edited_voice_once(tmp_path, monkeypatch):
    paths = _inputs(tmp_path)
    render = _render(tmp_path, paths)
    calls = _count_measurements(monkeypatch)
    render._prepare_voice()
    edited = render.vocal
    render._finish_voice()
    assert calls[paths[2]] == 1, "The immutable reference must not be analyzed twice"
    assert calls[edited] == 1, "Unchanged prepared PCM must reuse its complete measurement"
    assert sum(calls.values()) == 9, "Changed insert outputs still require their own analysis"


@pytest.mark.parametrize("channels", [1, 2])
def test_reuse_keeps_pcm_reports_and_feature_arrays_exact(tmp_path, channels):
    paths = _inputs(tmp_path, channels)
    render = _render(tmp_path, paths)
    edited, target = tmp_path / "uncached-edit.wav", tmp_path / "uncached-inserts.wav"
    expected_edit = prepare_voice(
        render.renderer, paths[0], edited, render.cancel, reference=paths[2]
    )
    expected_voice = process_voice(
        render.renderer,
        edited,
        target,
        render.cancel,
        reference=paths[2],
        arrangement=render.arrangement,
    )
    render._prepare_voice()
    cached = render.voice_analysis.measure(render.vocal, render.cancel)
    expected_features = features.analyze_voice(edited, render.cancel)
    render._finish_voice()
    assert render.processing["preparation"] == expected_edit
    assert render.processing["vocalChain"] == expected_voice
    np.testing.assert_array_equal(sf.read(render.vocal)[0], sf.read(target)[0])
    _equal_features(cached, expected_features)
    assert all(
        not getattr(cached, field.name).flags.writeable
        for field in fields(cached)
        if isinstance(getattr(cached, field.name), np.ndarray)
    )


@pytest.mark.parametrize("change", ["rewrite", "replacement", "new-path"])
def test_changed_or_pitch_replaced_source_is_measured_again(tmp_path, monkeypatch, change):
    path = _inputs(tmp_path)[0]
    cache, cancel = _cache(), threading.Event()
    calls = _count_measurements(monkeypatch)
    before = cache.measure(path, cancel)
    original_stat = path.stat()
    samples, rate = sf.read(path)
    replacement = tmp_path / "pitch-balanced.wav"
    target = path if change == "rewrite" else replacement
    sf.write(target, samples * 0.5, rate, subtype="FLOAT")
    mtime = original_stat.st_mtime_ns + (1_000_000 if change == "rewrite" else 0)
    os.utime(target, ns=(original_stat.st_atime_ns, mtime))
    if change == "replacement":
        os.replace(target, path)
        target = path
    after = cache.measure(target, cancel)
    assert sum(calls.values()) == 2
    assert before is not after
    _equal_features(after, features.analyze_voice(target, cancel))
    assert float(np.max(after.peak_db)) < float(np.max(before.peak_db)) - 5


def test_cache_hit_honors_cancellation_and_does_not_remeasure(tmp_path, monkeypatch):
    path = _inputs(tmp_path)[0]
    cache, cancel = _cache(), threading.Event()
    calls = _count_measurements(monkeypatch)
    cache.measure(path, cancel)
    cancel.set()
    with pytest.raises(DomainError, match="cancel"):
        cache.measure(path, cancel)
    assert calls[path] == 1


def test_reuse_does_not_hide_deleted_or_nonfinite_audio(tmp_path):
    path = _inputs(tmp_path)[0]
    cache, cancel = _cache(), threading.Event()
    cache.measure(path, cancel)
    path.unlink()
    with pytest.raises(FileNotFoundError):
        cache.measure(path, cancel)
    sf.write(path, np.full(8000, np.nan), 8000, subtype="FLOAT")
    with pytest.raises(DependencyError, match="finite"):
        cache.measure(path, cancel)


def test_cache_lifetime_is_one_master_render(tmp_path, monkeypatch):
    paths = _inputs(tmp_path)
    first = _render(tmp_path, paths)
    other = tmp_path / "other-render"
    other.mkdir()
    second = _render(other, paths)
    calls = _count_measurements(monkeypatch)
    assert first.voice_analysis is not second.voice_analysis
    first.voice_analysis.measure(paths[0], first.cancel)
    second.voice_analysis.measure(paths[0], second.cancel)
    assert calls[paths[0]] == 2


def test_source_changed_during_analysis_is_not_cached(tmp_path, monkeypatch):
    path = _inputs(tmp_path)[0]
    measure = features._measure_blocks

    def replace_after_blocks(source, cancel):
        result = measure(source, cancel)
        sf.write(source, np.zeros(8000), 8000, subtype="FLOAT")
        return result

    monkeypatch.setattr(features, "_measure_blocks", replace_after_blocks)
    with pytest.raises(DependencyError, match="changed"):
        _cache().measure(path, threading.Event())
