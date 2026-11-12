"""Regression: dry and existing-effects stems use the same peak-only delivery."""

from pathlib import Path
import ast
import threading
import math
import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.ffmpeg_audio import loudnorm_filter, parse_loudness
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_delivery import measure_stem_loudness
from backend.recordings.studio_delivery import measure_mix_loudness
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def test_delivery_has_no_stem_dependent_master_loudness():
    source = Path(__file__).resolve().parents[1] / "backend/recordings/studio_delivery.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    cls = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "MasterDelivery"
    )
    run = next(
        node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == "run"
    )
    assert not any(
        isinstance(node, ast.If)
        and isinstance(node.test, ast.Attribute)
        and node.test.attr == "process_voice"
        for node in ast.walk(run)
    )
    assert "alimiter=limit=" in ast.get_source_segment(source.read_text(encoding="utf-8"), run)


@pytest.mark.parametrize("rate", [8000, 44100, 48000])
def test_stem_meter_preserves_loudness_and_source_pcm(tmp_path, rate):
    path = tmp_path / "stem.wav"
    samples = np.random.default_rng(74).normal(0, 0.05, (rate * 4, 2))
    samples[rate : 2 * rate] *= 0.25
    sf.write(path, samples, rate, subtype="FLOAT")
    original = path.read_bytes()
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    cancel = threading.Event()
    old = renderer._mix(
        path,
        path,
        "[0:a]" + loudnorm_filter(lra=11) + "[out]",
        ["-f", "null", "-"],
        cancel,
        quiet=False,
    )
    expected = parse_loudness(old.stderr)
    assert expected is not None
    actual = measure_stem_loudness(renderer, path, None, cancel)
    assert actual == pytest.approx(expected["input_i"], abs=0.1)
    assert path.read_bytes() == original


def test_silent_stem_meter_does_not_supply_a_finite_balance_target(tmp_path):
    path = tmp_path / "silence.wav"
    sf.write(path, np.zeros(44100), 44100)
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    assert not math.isfinite(measure_stem_loudness(renderer, path, None, threading.Event()))


@pytest.mark.parametrize("rate", [8000, 44100, 48000])
@pytest.mark.parametrize("stereo", [False, True])
def test_paired_loudness_preserves_known_gain_and_antiphase_energy(tmp_path, rate, stereo):
    time = np.arange(rate * 4) / rate
    samples = 0.05 * np.sin(2 * np.pi * 1000 * time)
    if stereo:
        samples = np.column_stack((samples, -samples))
    vocal, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    sf.write(vocal, samples * 2, rate, subtype="FLOAT")
    sf.write(backing, samples, rate, subtype="FLOAT")
    before = [path.read_bytes() for path in (vocal, backing)]
    voice, music = measure_mix_loudness(
        FfmpegStudioMasterRenderer(ProcessRunner()), vocal, backing, threading.Event()
    )
    assert voice.shape == music.shape and len(voice) == 40
    np.testing.assert_allclose(voice[3:] - music[3:], 20 * np.log10(2), atol=0.002)
    assert [path.read_bytes() for path in (vocal, backing)] == before
