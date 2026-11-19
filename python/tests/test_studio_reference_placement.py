"""Verified source balance determines vocal placement instead of a fixed boost."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_audio import _write_gain_envelope
from backend.recordings.studio_calibration import build_gain_plan
from backend.recordings.studio_delivery import measure_mix_loudness
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def _render(
    root, source_ratio, publication_gains=(1.0, 1.0), verified=True, reference_case="valid"
):
    rate = 44100
    time = np.arange(rate * 8) / rate
    vocal = 0.05 * np.sin(2 * np.pi * 700 * time)
    music = 0.05 * np.sin(2 * np.pi * 900 * time) * publication_gains[1]
    reference = vocal * 10 ** (source_ratio / 20) * publication_gains[0]
    paths = [root / f"{name}.wav" for name in ("voice", "backing", "reference", "output")]
    for path, data in zip(paths, (vocal, music, reference)):
        sf.write(path, data, rate, subtype="FLOAT")
    renderer, cancel = FfmpegStudioMasterRenderer(ProcessRunner()), threading.Event()
    reference_voice, reference_music = measure_mix_loudness(renderer, paths[2], paths[1], cancel)
    axis = (np.arange(len(reference_voice)) + 1) * 0.1 - 0.2
    correction = 20 * np.log10(publication_gains[1] / publication_gains[0])
    balance = (axis, reference_voice, reference_music)
    if reference_case == "missing":
        balance = None
    elif reference_case == "silent":
        balance = (axis, np.full_like(reference_voice, -120), reference_music)
    elif reference_case == "short":
        balance = tuple(values[:5] for values in balance)
    elif reference_case == "nonfinite":
        correction = np.nan
    plan = build_gain_plan(
        renderer,
        paths[0],
        paths[1],
        0.5,
        cancel,
        reference_balance=balance,
        reference_level_correction_db=correction if verified else None,
    )
    _write_gain_envelope(paths[0], paths[3], plan.times, plan.gains, cancel)
    output_voice, output_music = measure_mix_loudness(renderer, paths[3], paths[1], cancel)
    expected = float(np.median((reference_voice - reference_music + correction)[10:-10]))
    actual = float(np.median((output_voice - output_music)[10:-10]))
    return expected, actual, plan


@pytest.mark.parametrize("ratio", [-12, -6, 0])
@pytest.mark.parametrize("gains", [(1.0, 1.0), (0.1, 0.7)])
def test_verified_reference_sets_measured_output_ratio_without_fixed_lift(tmp_path, ratio, gains):
    expected, actual, plan = _render(tmp_path, ratio, gains)
    assert actual == pytest.approx(expected, abs=0.3)
    assert plan.report["balanceBasis"] == "verified-source-reference"
    assert plan.report["vocalLiftDb"] == 0
    assert plan.report["presenceCompensationDb"] == 0


def test_unverified_reference_keeps_explicit_fallback_instead_of_claiming_absolute_balance(
    tmp_path,
):
    _, actual, plan = _render(tmp_path, -12, verified=False)
    assert abs(actual) < 0.3
    assert plan.report["balanceBasis"] == "uncalibrated-reference-fallback"
    assert plan.report["vocalLiftDb"] == 1.5


@pytest.mark.parametrize("reference_case", ["missing", "silent", "short", "nonfinite"])
def test_trusted_source_alone_cannot_claim_applied_reference_placement(tmp_path, reference_case):
    _, actual, plan = _render(tmp_path, -12, reference_case=reference_case)
    assert abs(actual) < 0.3
    assert plan.report["balanceBasis"] == "uncalibrated-reference-fallback"
    assert plan.report["vocalLiftDb"] == 1.5


def test_verified_reference_preserves_a_genuinely_quieter_sung_section(tmp_path):
    rate = 44100
    time = np.arange(rate * 30) / rate
    voice = 0.05 * np.sin(2 * np.pi * 700 * time)
    music = 0.05 * np.sin(2 * np.pi * 900 * time)
    reference = voice * np.where(time >= 20, 10 ** (-9 / 20), 1)
    vocal, backing, guide, output = [
        tmp_path / f"{name}.wav" for name in ("vocal", "backing", "guide", "out")
    ]
    for path, samples in zip((vocal, backing, guide), (voice, music, reference)):
        sf.write(path, samples, rate, subtype="FLOAT")
    renderer, cancel = FfmpegStudioMasterRenderer(ProcessRunner()), threading.Event()
    rv, rb = measure_mix_loudness(renderer, guide, backing, cancel)
    axis = (np.arange(len(rv)) + 1) * 0.1 - 0.2
    plan = build_gain_plan(
        renderer,
        vocal,
        backing,
        0.5,
        cancel,
        reference_balance=(axis, rv, rb),
        reference_level_correction_db=0,
    )
    _write_gain_envelope(vocal, output, plan.times, plan.gains, cancel)
    actual, _ = sf.read(output)
    first, second = (time >= 4) & (time < 10), (time >= 24) & (time < 28)
    difference = 10 * np.log10(np.mean(actual[second] ** 2) / np.mean(actual[first] ** 2))
    assert difference == pytest.approx(-9, abs=0.4)
