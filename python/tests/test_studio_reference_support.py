"""Reference pauses are not evidence for quieter sung word bodies."""

import threading

import numpy as np
import pytest
from scipy.signal import butter, sosfilt
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.domain_errors import DomainError
from backend.recordings.studio_audio import _profile, _write_gain_envelope
from backend.recordings.studio_calibration import (
    _voiced_activity,
    build_gain_plan,
    measure_reference_body,
)
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_render import MasterRender
from backend.recordings.studio_vocal_context import ReferenceBody


_DURATIONS = (0.08, 0.15, 0.28, 0.12, 0.32, 0.1, 0.18, 0.24, 0.15)


def _signal(time, rate, frequency, *, sparse=True, cycles=1):
    phrase_end = 11 + (cycles - 1) * len(_DURATIONS) * 0.8
    envelope = ((time < 3) | (time >= phrase_end)).astype(float) if sparse else np.ones_like(time)
    if sparse:
        for index, duration in enumerate(_DURATIONS * cycles):
            start = 3.5 + index * 0.8
            attack = np.clip((time - start) / 0.005, 0, 1)
            release = np.clip((start + duration - time) / 0.005, 0, 1)
            envelope = np.maximum(envelope, np.minimum(attack, release))
    carrier = sum(
        np.sin(2 * np.pi * frequency * harmonic * time + 0.13 * harmonic) / harmonic
        for harmonic in range(1, 9)
    )
    carrier *= (0.05 / np.sqrt(2)) / np.sqrt(np.mean(carrier**2))
    noise = sosfilt(
        butter(2, [500, 3400], fs=rate, btype="bandpass", output="sos"),
        np.random.default_rng(73).normal(size=len(time)),
    )
    noise *= (0.05 / np.sqrt(2) * 10 ** (-18 / 20)) / np.sqrt(np.mean(noise**2))
    return carrier * envelope + noise * (1 - envelope)


def _plan(root, rate, voice, reference, *, source_start=0):
    time = np.arange(len(voice)) / rate
    music = 0.05 * np.sin(2 * np.pi * 900 * time)
    source, guide, backing, original = [
        root / f"{name}.wav" for name in ("voice", "reference", "backing", "original")
    ]
    reference_music = 0.05 * np.sin(2 * np.pi * 900 * np.arange(len(reference)) / rate)
    inputs = ((source, voice), (guide, reference), (backing, music), (original, reference_music))
    for path, samples in inputs:
        sf.write(path, samples, rate, subtype="FLOAT")
    renderer, cancel = FfmpegStudioMasterRenderer(ProcessRunner()), threading.Event()
    render = MasterRender(
        renderer,
        source,
        backing,
        guide,
        original,
        root / "output.wav",
        cancel,
        source,
        True,
        True,
        False,
        (),
        None,
    )
    render.vocal, render.backing, render.processing = source, backing, {}
    render.voice_db, render.reference_db, render.backing_db = [
        _profile(path, cancel) for path in (source, guide, backing)
    ]
    render.original_db = _profile(original, cancel)
    render.offset_result = (source_start, 1.0)
    render.reference_level_correction_db = 0
    render._balance_performance()
    plan = render._gain_plan()
    originals = [path.read_bytes() for path in (source, guide, backing)]
    _write_gain_envelope(source, render.target, plan.times, plan.gains, cancel)
    output, actual_rate = sf.read(render.target)
    assert actual_rate == rate and output.shape == voice.shape and np.isfinite(output).all()
    assert [path.read_bytes() for path in (source, guide, backing)] == originals
    voiced = _voiced_activity(source, plan.times, plan.active, cancel)
    return output, plan, voiced, render


def _level(samples):
    return 10 * np.log10(np.mean(samples**2))


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("frequency", [140, 220])
def test_short_word_body_level_is_independent_of_reference_pause_density(tmp_path, rate, frequency):
    time = np.arange(rate * 14) / rate
    voice = _signal(time, rate, frequency)
    output, plan, voiced, _ = _plan(tmp_path, rate, voice, voice.copy())
    assert plan.report["placementLevelBasis"] == "paired-voiced-body-context"
    steady = (time >= 1) & (time < 2)
    errors = []
    for index, duration in enumerate(_DURATIONS):
        start = 3.5 + index * 0.8
        body = (time >= start + 0.02) & (time < start + duration - 0.02)
        evidence = (plan.times >= start + 0.02) & (plan.times < start + duration - 0.02)
        assert voiced[evidence].all(), "This must exercise sung words, not the unvoiced fallback"
        before = _level(voice[body]) - _level(voice[steady])
        after = _level(output[body]) - _level(output[steady])
        errors.append(after - before)
    before_phrase = (plan.times >= 1) & (plan.times < 2)
    assert abs(np.median(plan.gains[before_phrase])) < 0.75
    assert np.max(np.abs(errors)) < 0.75, errors


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("frequency", [140, 220])
def test_verified_sparse_quiet_reference_keeps_its_measured_phrase_level(tmp_path, rate, frequency):
    time = np.arange(round(rate * 21.2)) / rate
    voice = _signal(time, rate, frequency, cycles=2)
    # Uniform phrase scaling preserves SNR. This isolates reference level from
    # the existing momentary-to-RMS approximation for changing spectral mixtures.
    reference = voice * np.where((time >= 3) & (time < 18.2), 10 ** (-6 / 20), 1)
    output, plan, _, _ = _plan(tmp_path, rate, voice, reference)
    steady = (time >= 1) & (time < 2)
    errors = []
    for index, duration in enumerate(_DURATIONS * 2):
        start = 3.5 + index * 0.8
        body = (time >= start + 0.02) & (time < start + duration - 0.02)
        before = _level(voice[body]) - _level(voice[steady])
        after = _level(output[body]) - _level(output[steady])
        assert -6.75 <= after - before <= 0.75
        # Stay outside both composed phrase-smoothing boundaries; every word
        # including those boundaries is still checked for identity above.
        if 6 <= start < 15:
            errors.append(after - before + 6)
    assert abs(np.median(plan.gains[(plan.times >= 1) & (plan.times < 2)])) < 0.75
    assert np.max(np.abs(errors)) < 0.75, errors


@pytest.mark.parametrize("frequency", [140, 220])
def test_reference_articulation_density_does_not_attenuate_a_continuing_voice(tmp_path, frequency):
    rate = 48000
    time = np.arange(rate * 14) / rate
    voice = _signal(time, rate, frequency, sparse=False)
    reference = _signal(time, rate, frequency)
    output, _, _, _ = _plan(tmp_path, rate, voice, reference)
    steady, phrase = (time >= 1) & (time < 2), (time >= 5) & (time < 9)
    before = _level(voice[phrase]) - _level(voice[steady])
    after = _level(output[phrase]) - _level(output[steady])
    assert abs(after - before) < 0.75


def test_short_word_support_survives_falling_between_control_centers():
    times = (np.arange(100) + 0.5) * 0.02
    supported = (times >= 0.96) & (times < 1.04)
    body = ReferenceBody(times, np.full_like(times, -30.0), supported)
    control = (np.arange(20) + 0.5) * 0.1
    pooled = body.on_grid(control)
    assert not supported[np.argmin(abs(times - 0.95))]
    assert pooled.supported[(control > 0.9) & (control < 1.1)].all()
    assert not pooled.supported[(control < 0.9) | (control > 1.1)].any()


@pytest.mark.parametrize("source_start", [0.0, 1.37, 8.0])
def test_reference_support_respects_leading_silence_prefix_and_source_mapping(
    tmp_path, source_start
):
    rate = 48000
    time = np.arange(rate * 8) / rate
    voice = _signal(time, rate, 140, sparse=False)
    guide = voice[: 6 * rate].copy()
    guide[: 2 * rate] = 0
    _, _, _, render = _plan(tmp_path, rate, voice, guide, source_start=source_start)
    body = render.reference_body
    assert body is not None
    source = body.times + source_start
    assert not body.supported[(source < 1.95) | (source > 6)].any()
    if source_start < 6:
        assert body.supported[(source >= 2.2) & (source < 5.8)].all()
    else:
        assert not body.supported.any()
        assert render._gain_plan().report["placementLevelBasis"] == "momentary-reference"
    assert np.all(body.levels[source > 6] == -120)


@pytest.mark.parametrize("kind", ["silence", "noise", "brief-voice"])
def test_insufficient_reference_body_preserves_explicit_fallback(tmp_path, kind):
    rate = 44100
    time = np.arange(rate * 8) / rate
    voice = _signal(time, rate, 140, sparse=False)
    reference = np.zeros_like(voice)
    if kind == "noise":
        reference = np.random.default_rng(421).normal(0, 0.02, len(voice))
    elif kind == "brief-voice":
        reference[3 * rate : round(3.3 * rate)] = voice[3 * rate : round(3.3 * rate)]
    _, plan, _, render = _plan(tmp_path, rate, voice, reference)
    assert render.reference_body is None
    expected = build_gain_plan(
        render.renderer,
        render.vocal,
        render.backing,
        0,
        render.cancel,
        reference_balance=render.reference_balance,
        reference_level_correction_db=0,
    )
    np.testing.assert_array_equal(plan.gains, expected.gains)
    assert plan.report["placementLevelBasis"] == "momentary-reference"


@pytest.mark.parametrize("correction", [None, np.nan, np.inf])
def test_body_evidence_cannot_change_unverified_reference_fallback(tmp_path, correction):
    rate = 44100
    time = np.arange(rate * 8) / rate
    voice = _signal(time, rate, 140)
    _, _, _, render = _plan(tmp_path, rate, voice, voice.copy())
    assert render.reference_body is not None
    plans = [
        build_gain_plan(
            render.renderer,
            render.vocal,
            render.backing,
            0,
            render.cancel,
            reference_balance=render.reference_balance,
            reference_level_correction_db=correction,
            reference_body=body,
        )
        for body in (None, render.reference_body)
    ]
    np.testing.assert_array_equal(plans[0].gains, plans[1].gains)
    assert plans[1].report["placementLevelBasis"] == "momentary-reference"


@pytest.mark.parametrize("cancel_at_final_read", [False, True])
def test_body_profile_reads_are_bounded_and_final_cancellation_propagates(
    tmp_path, monkeypatch, cancel_at_final_read
):
    rate = 48000
    time = np.arange(rate * 2) / rate
    voice = tmp_path / "source.wav"
    sf.write(voice, _signal(time, rate, 140, sparse=False), rate, subtype="FLOAT")
    cancel, reads = threading.Event(), []
    original, opened = sf.SoundFile, []

    class Reader(original):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            opened.append(self)

        def read(self, frames=-1, *args, **kwargs):
            assert 0 < frames <= round(3.2 * self.samplerate)
            result = super().read(frames, *args, **kwargs)
            reads.append(frames)
            if cancel_at_final_read and len(opened) == 3 and self.tell() == self.frames:
                cancel.set()
            return result

    monkeypatch.setattr(sf, "SoundFile", Reader)
    axis = (np.arange(20) + 1) * 0.1 - 0.2
    if cancel_at_final_read:
        with pytest.raises(DomainError) as error:
            measure_reference_body(voice, axis, np.full(20, -30.0), cancel)
        assert error.value.code == "ProcessCancelled"
    else:
        assert measure_reference_body(voice, axis, np.full(20, -30.0), cancel) is not None
    assert reads
