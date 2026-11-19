"""A trusted broadband placement must not disable independent masking EQ."""

from dataclasses import replace
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.domain_errors import DomainError
from backend.recordings.studio_audio import _write_gain_envelope
from backend.recordings.studio_calibration import _presence_correction, build_gain_plan
from backend.recordings.studio_delivery import measure_mix_loudness
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_render import MasterRender
from backend.recordings import studio_render
from backend.recordings.studio_spectrum import plan_presence_eq
from backend.recordings.studio_voice import shape_voice
from backend.recordings.studio_clarity import presence_profile


def _fixture(root):
    rate = 16000
    time = np.arange(rate * 8) / rate
    carrier = {hz: np.sin(2 * np.pi * hz * time) for hz in (150, 900, 1800)}
    own = 0.14 * carrier[150] + 0.025 * carrier[900] + 0.013 * carrier[1800]
    reference = 0.015 * carrier[150] + 0.035 * carrier[900] + 0.02 * carrier[1800]
    backing = 0.06 * carrier[900] + 0.03 * carrier[1800]
    backing[time >= 4] = 0.06 * np.sin(2 * np.pi * 230 * time[time >= 4])
    paths = {name: root / f"{name}.wav" for name in ("voice", "reference", "backing")}
    for name, samples in zip(paths, (own, reference, backing)):
        sf.write(paths[name], samples, rate, subtype="FLOAT")
    renderer, cancel = FfmpegStudioMasterRenderer(ProcessRunner()), threading.Event()
    voice, music = measure_mix_loudness(renderer, paths["reference"], paths["backing"], cancel)
    axis = (np.arange(len(voice)) + 1) * 0.1 - 0.2
    return paths, renderer, cancel, (axis, voice, music)


def _plan(paths, renderer, cancel, reference, voice=None):
    vocal = presence_profile(paths["reference"], cancel)[:, 1:]
    music = presence_profile(paths["backing"], cancel, center=True)[:, 1:]
    axis = (np.arange(len(vocal)) + 0.5) * 0.1
    return build_gain_plan(
        renderer,
        paths["voice"] if voice is None else voice,
        paths["backing"],
        0.5,
        cancel,
        reference_balance=reference,
        reference_level_correction_db=0,
        reference_presence=(axis, vocal, music),
    )


def _measured_control(paths, plan, reference, cancel):
    axis, voice, music = reference
    masking = _presence_correction(
        paths["voice"],
        paths["backing"],
        plan.times,
        plan.gains,
        plan.active,
        np.interp(plan.times, axis, voice - music),
        cancel,
    )
    return replace(plan, presence=masking, clarity=masking, clarity_bands=None)


def _clarity(path, start, end):
    samples, rate = sf.read(path)
    samples = samples[round(start * rate) : round(end * rate)]
    time = np.arange(len(samples)) / rate
    amplitudes = [2 * abs(np.mean(samples * np.exp(-2j * np.pi * hz * time))) for hz in (150, 900)]
    return 20 * np.log10(amplitudes[1] / amplitudes[0])


def test_verified_placement_does_not_veto_measured_clarity_band(tmp_path):
    paths, renderer, cancel, reference = _fixture(tmp_path)
    plan = _plan(paths, renderer, cancel, reference)
    control = _measured_control(paths, plan, reference, cancel)
    np.testing.assert_array_equal(control.gains, plan.gains)
    np.testing.assert_array_equal(control.target, plan.target)
    assert plan.report["balanceBasis"] == "verified-source-reference"
    assert plan.report["presenceCompensationDb"] == 0
    positive = plan_presence_eq(paths["voice"], paths["backing"], control, cancel)
    assert positive and positive[0]["gainDb"] > 2

    actual = plan_presence_eq(paths["voice"], paths["backing"], plan, cancel)

    assert actual == positive


def test_verified_clarity_blend_changes_masked_band_without_changing_placement(tmp_path):
    paths, renderer, cancel, reference = _fixture(tmp_path)
    original = {name: path.read_bytes() for name, path in paths.items()}
    plan = _plan(paths, renderer, cancel, reference)
    control = _measured_control(paths, plan, reference, cancel)
    bands = plan_presence_eq(paths["voice"], paths["backing"], control, cancel)
    spectral = {"bands": bands, "clarityBands": bands, "overlap": 0.5, "ratioDb": []}
    shaped, _ = shape_voice(
        renderer,
        paths["voice"],
        paths["backing"],
        tmp_path / "shaped.wav",
        cancel,
        plan=spectral,
        automation=plan,
    )
    after = _plan(paths, renderer, cancel, reference, shaped)
    output = tmp_path / "balanced.wav"
    _write_gain_envelope(shaped, output, after.times, after.gains, cancel)
    voice, music = measure_mix_loudness(renderer, output, paths["backing"], cancel)

    assert 1.5 < _clarity(output, 1, 3) - _clarity(paths["voice"], 1, 3) < 3
    assert abs(_clarity(output, 5, 7) - _clarity(paths["voice"], 5, 7)) < 0.05
    assert np.median((voice - music - reference[1] + reference[2])[10:-10]) == pytest.approx(
        0, abs=0.3
    )
    assert after.report["presenceCompensationDb"] == 0
    assert {name: path.read_bytes() for name, path in paths.items()} == original


def _master(paths, renderer, cancel, root, monkeypatch, clarity):
    captured = root / "calibrated.wav"
    finish = MasterRender._finish_voice

    def capture(render):
        samples, rate = sf.read(render.balanced)
        sf.write(captured, samples, rate, subtype="FLOAT")
        finish(render)

    with monkeypatch.context() as scoped:
        scoped.setattr(MasterRender, "_finish_voice", capture)
        if not clarity:
            scoped.setattr(studio_render, "plan_presence_eq", lambda *args, **kwargs: [])
        result = renderer.render(
            paths["voice"],
            paths["backing"],
            paths["reference"],
            paths["backing"],
            root / "master.wav",
            cancel,
            performance_mix=paths["mix"],
            reference_mix=paths["source"],
            exact_stems=True,
            process_voice=True,
            adjustments=[
                {"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}
            ],
        )
    assert result.processing["referenceLevel"]["status"] == "verified"
    assert result.processing["gainPlan"]["presenceCompensationDb"] == 0
    return captured, result


def test_actual_master_keeps_verified_balance_and_restores_only_masked_clarity(
    tmp_path, monkeypatch
):
    paths, renderer, cancel, reference = _fixture(tmp_path)
    voice, guide, backing = [sf.read(paths[key])[0] for key in ("voice", "reference", "backing")]
    for name, samples in [("mix", voice + backing), ("source", guide + backing)]:
        paths[name] = tmp_path / f"{name}.wav"
        sf.write(paths[name], samples, 16000, subtype="FLOAT")
    outputs = []
    for enabled in (False, True):
        work = tmp_path / str(enabled)
        work.mkdir()
        outputs.append(_master(paths, renderer, cancel, work, monkeypatch, enabled))
    before, after = outputs[0][0], outputs[1][0]
    actual_voice, actual_music = measure_mix_loudness(renderer, after, paths["backing"], cancel)

    assert 1.5 < _clarity(after, 1, 3) - _clarity(before, 1, 3) < 3
    assert abs(_clarity(after, 5, 7) - _clarity(before, 5, 7)) < 0.1
    assert np.median((actual_voice - actual_music - reference[1] + reference[2])[10:-10]) == (
        pytest.approx(0, abs=0.3)
    )
    assert outputs[1][1].processing["spectralPlan"]["clarityBands"]


def test_reference_deficit_can_need_eq_when_voice_is_already_above_backing(tmp_path):
    paths, renderer, cancel, _ = _fixture(tmp_path)
    music, rate = sf.read(paths["backing"])
    sf.write(paths["backing"], music * 0.1, rate, subtype="FLOAT")
    voice, music = measure_mix_loudness(renderer, paths["reference"], paths["backing"], cancel)
    axis = (np.arange(len(voice)) + 1) * 0.1 - 0.2
    plan = _plan(paths, renderer, cancel, (axis, voice, music))
    old_zero_target = replace(plan, clarity_bands=None)
    assert not plan_presence_eq(paths["voice"], paths["backing"], old_zero_target, cancel)

    actual = plan_presence_eq(paths["voice"], paths["backing"], plan, cancel)

    assert actual and 1.5 < actual[0]["gainDb"] <= 3
    assert 800 < actual[0]["frequencyHz"] < 1800
    assert plan.report["presenceCompensationDb"] == 0


@pytest.mark.parametrize("kind", ["clear", "dark", "breath"])
@pytest.mark.parametrize("source_gain_db", [0, -9])
def test_trusted_master_does_not_invent_clarity_for_matching_or_unvoiced_source(
    tmp_path, monkeypatch, kind, source_gain_db
):
    paths, renderer, cancel, _ = _fixture(tmp_path)
    voice, guide, backing = [sf.read(paths[key])[0] for key in ("voice", "reference", "backing")]
    if kind == "clear":
        voice = guide.copy()
    elif kind == "dark":
        guide = voice.copy()
    else:
        voice = np.random.default_rng(76).normal(0, 0.025, len(voice))
    for name, samples in [
        ("voice", voice),
        ("reference", guide),
        ("mix", voice + backing),
        ("source", guide * 10 ** (source_gain_db / 20) + backing),
    ]:
        paths[name] = tmp_path / f"{name}.wav"
        sf.write(paths[name], samples, 16000, subtype="FLOAT")
    original = {name: path.read_bytes() for name, path in paths.items()}
    captured, result = _master(paths, renderer, cancel, tmp_path, monkeypatch, True)
    assert result.processing["spectralPlan"]["clarityBands"] == []
    if kind != "breath":
        own, music = measure_mix_loudness(renderer, captured, paths["backing"], cancel)
        ref, _ = measure_mix_loudness(renderer, paths["reference"], paths["backing"], cancel)
        assert np.median((own - music - ref + music)[10:-10]) == pytest.approx(
            source_gain_db, abs=0.3
        )
    assert {name: path.read_bytes() for name, path in paths.items()} == original


@pytest.mark.parametrize("invalid", ["missing", "quiet", "nonfinite", "wrong_shape"])
def test_trusted_plan_abstains_without_valid_reference_band_evidence(tmp_path, invalid):
    paths, renderer, cancel, reference = _fixture(tmp_path)
    profile = presence_profile(paths["reference"], cancel)[:, 1:]
    music = presence_profile(paths["backing"], cancel, center=True)[:, 1:]
    axis = (np.arange(len(profile)) + 0.5) * 0.1
    if invalid == "quiet":
        profile[:] = -120
    elif invalid == "nonfinite":
        profile[10, 1] = np.nan
    elif invalid == "wrong_shape":
        profile = profile[:, 0]
    plan = build_gain_plan(
        renderer,
        paths["voice"],
        paths["backing"],
        0.5,
        cancel,
        reference_balance=reference,
        reference_level_correction_db=0,
        reference_presence=None if invalid == "missing" else (axis, profile, music),
    )
    assert plan.report["presenceCompensationDb"] == 0
    assert not plan.clarity.any()
    assert plan_presence_eq(paths["voice"], paths["backing"], plan, cancel) == []


@pytest.mark.parametrize("rate", [44100, 48000])
def test_clarity_profile_keeps_antiphase_energy_and_bounded_cancel(tmp_path, monkeypatch, rate):
    time = np.arange(round(rate * 3.7)) / rate
    voice = 0.08 * np.sin(2 * np.pi * 900 * time) + 0.04 * np.sin(2 * np.pi * 1800 * time)
    path = tmp_path / "stereo.wav"
    sf.write(path, np.column_stack((voice, -voice)), rate, subtype="FLOAT")
    levels = presence_profile(path, threading.Event())
    assert np.median(levels[:, 1]) == pytest.approx(
        10 * np.log10((0.08**2 + 0.04**2) / 2), abs=0.01
    )
    cancel, original = threading.Event(), sf.SoundFile.read

    def cancel_final_read(audio, frames=-1, *args, **kwargs):
        assert 0 <= frames <= round(rate * 3.2)
        samples = original(audio, frames, *args, **kwargs)
        if audio.tell() == audio.frames:
            cancel.set()
        return samples

    monkeypatch.setattr(sf.SoundFile, "read", cancel_final_read)
    with pytest.raises(DomainError) as error:
        presence_profile(path, cancel)
    assert error.value.code == "ProcessCancelled"


@pytest.mark.parametrize("unsupported", ["breath", "missing_reference"])
def test_clarity_fades_inside_support_without_coloring_following_noise_or_unmatched_audio(
    tmp_path, unsupported
):
    paths, renderer, cancel, _ = _fixture(tmp_path)
    rate = 16000
    own, guide, music = [sf.read(paths[key])[0] for key in ("voice", "reference", "backing")]
    if unsupported == "breath":
        own[4 * rate :] = np.random.default_rng(1005).normal(0, 0.03, 4 * rate)
    else:
        guide[4 * rate :] = 0
    # Keep a real masker after the boundary: only vocal/reference evidence ends.
    music[4 * rate :] = music[: 4 * rate]
    for name, samples in [("voice", own), ("reference", guide), ("backing", music)]:
        sf.write(paths[name], samples, rate, subtype="FLOAT")
    voice, backing = measure_mix_loudness(renderer, paths["reference"], paths["backing"], cancel)
    axis = (np.arange(len(voice)) + 1) * 0.1 - 0.2
    plan = _plan(paths, renderer, cancel, (axis, voice, backing))
    bands = plan_presence_eq(paths["voice"], paths["backing"], plan, cancel)
    assert bands
    output, _ = shape_voice(
        renderer,
        paths["voice"],
        paths["backing"],
        tmp_path / "shaped.wav",
        cancel,
        plan={"bands": bands, "clarityBands": bands, "overlap": 0.5, "ratioDb": []},
        automation=plan,
    )
    before, after = [sf.read(path)[0] for path in (paths["voice"], output)]
    difference = after - before
    assert np.sqrt(np.mean(difference[rate : 3 * rate] ** 2)) > 0.001
    np.testing.assert_array_equal(after[round(4.06 * rate) :], before[round(4.06 * rate) :])
    interior_slope = np.max(abs(np.diff(difference[2 * rate : 3 * rate])))
    boundary_slope = np.max(abs(np.diff(difference[round(3.6 * rate) : round(4.4 * rate)])))
    assert boundary_slope < interior_slope * 1.2
