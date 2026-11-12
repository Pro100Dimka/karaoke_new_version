from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_delivery import MasterDelivery
from backend.recordings.studio_dynamics import _balance_curve
from backend.recordings.studio_space import apply_reference_space
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_reference import reference_section
from backend.recordings.studio_render import MasterRender


def test_unmatched_partial_take_does_not_use_whole_song_balance():
    render = MasterRender.__new__(MasterRender)
    render.gains = np.zeros(100)
    render.voice_db = np.full(100, -30.0)
    render.backing_db = np.full(100, -20.0)
    render.reference_db = np.tile([-25.0, -10.0], 200)
    render.original_db = np.full(400, -20.0)
    render.processing = {}
    render._fallback_balance()
    np.testing.assert_array_equal(render.gains, 0)


def test_reference_section_excludes_unperformed_song_and_rejects_seeks():
    adjustments = [{"elapsedSeconds": 0, "sourceSeconds": 40, "playbackRate": 1, "keyShift": 0}]
    assert reference_section(adjustments, 10) == (40, 50)
    assert reference_section([], 10) is None
    adjustments.append({"elapsedSeconds": 5, "sourceSeconds": 90, "playbackRate": 1, "keyShift": 0})
    assert reference_section(adjustments, 10) is None


def test_initial_balance_uses_the_performance_and_backing():
    levels = [np.full(100, value, dtype=float) for value in (-30, -30)]
    gains, reliable = _balance_curve(*levels)
    assert reliable.all()
    np.testing.assert_allclose(gains, 0, atol=0.01)


def test_peak_limiter_preserves_timeline_and_tail(tmp_path: Path):
    rate = 8000
    voice = np.zeros(rate)
    voice[50] = 0.2
    voice[-10] = 0.1
    v, b, output = (tmp_path / name for name in ("voice.wav", "backing.wav", "out.wav"))
    sf.write(v, voice, rate, subtype="FLOAT")
    sf.write(b, np.zeros_like(voice), rate, subtype="FLOAT")
    delivery = MasterDelivery(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        b,
        v,
        output,
        threading.Event(),
        sf.info(v),
        1,
        True,
        False,
        None,
        0.2,
        np.ones(10, dtype=bool),
        {},
        None,
    )
    delivery.run()
    actual, _ = sf.read(output)
    np.testing.assert_allclose(actual, voice, atol=2e-6)


def test_stereo_width_alone_does_not_synthesize_reverb(tmp_path: Path):
    rng = np.random.default_rng(77)
    rate = 8000
    dry = rng.normal(0, 0.04, (rate * 8, 1))
    dry = np.repeat(dry, 2, axis=1)
    reference = dry + rng.normal(0, 0.02, dry.shape)
    v, r, output = (tmp_path / name for name in ("voice.wav", "reference.wav", "out.wav"))
    sf.write(v, dry, rate, subtype="FLOAT")
    sf.write(r, reference, rate, subtype="FLOAT")
    report = apply_reference_space(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        r,
        v,
        v,
        output,
        threading.Event(),
    )
    assert report["status"] == "no-supported-addition"
    actual, _ = sf.read(output, always_2d=True)
    np.testing.assert_allclose(actual, dry, atol=1e-8)


def test_reference_balance_is_independent_of_channel_count(tmp_path: Path):
    from backend.recordings.studio_mix_audit import reference_voice_band_distribution

    rate = 8000
    signal = np.sin(2 * np.pi * 700 * np.arange(rate * 8) / rate) * 0.1
    vocal, backing = tmp_path / "mono.wav", tmp_path / "stereo.wav"
    sf.write(vocal, signal, rate, subtype="FLOAT")
    sf.write(backing, np.repeat(signal[:, None], 2, axis=1), rate, subtype="FLOAT")
    result = reference_voice_band_distribution(vocal, backing)
    assert result is not None
    assert abs(result["median"]) < 0.01


def test_calibration_reads_stems_without_modifying_them(tmp_path: Path):
    from backend.recordings.studio_calibration import calibrate_mix

    time = np.arange(8000 * 4) / 8000
    vocal, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    sf.write(vocal, 0.02 * np.sin(2 * np.pi * 500 * time), 8000, subtype="FLOAT")
    sf.write(backing, 0.1 * np.sin(2 * np.pi * 700 * time), 8000, subtype="FLOAT")
    before = [path.read_bytes() for path in (vocal, backing)]
    report = {}
    gain = calibrate_mix(
        FfmpegStudioMasterRenderer(ProcessRunner()), vocal, backing, threading.Event(), report
    )
    assert gain > 3
    assert [path.read_bytes() for path in (vocal, backing)] == before
    assert report["postMixCalibration"]["method"] == "perceptual-and-spectral-backing-balance"


def test_studio_separation_does_not_select_kaggle(tmp_path: Path):
    from types import SimpleNamespace
    from unittest.mock import Mock
    from backend.recordings.start_studio_master import StartStudioMaster
    from backend.ai.domain import AiCapability
    from backend.models.domain import ComputeMode

    master = StartStudioMaster.__new__(StartStudioMaster)
    master._settings = lambda: SimpleNamespace(
        selected_separation_provider="kaggle-p100", compute_mode=ComputeMode.CPU, cpu_threads=2
    )
    master._resolver = Mock()
    master._resources = Mock()
    recording = tmp_path / "recording.wav"
    recording.write_bytes(b"source")
    master._separate(SimpleNamespace(file_path=recording), tmp_path, Mock())
    master._resolver.execute.assert_called_once_with(AiCapability.SEPARATION, None)


def test_compression_is_bypassed_without_reference_transitions():
    from backend.recordings.studio_compression import _reference_compression

    recorded = np.tile(np.linspace(-30, -10, 50), 5)
    reference = np.tile(np.linspace(-20, -18, 50), 5)
    assert _reference_compression(recorded, reference)["ratio"] == 1


def test_seek_reference_contains_only_performed_sections(tmp_path: Path):
    from backend.recordings.studio_reference import scope_reference

    path = tmp_path / "reference.wav"
    samples = np.arange(16000, dtype=np.float32) / 16000
    sf.write(path, samples, 8000, subtype="FLOAT")
    adjustments = [
        {"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0},
        {"elapsedSeconds": 0.25, "sourceSeconds": 1, "playbackRate": 1, "keyShift": 0},
    ]
    vocal, _, _, report = scope_reference(path, path, adjustments, 0.5, tmp_path, threading.Event())
    actual, _ = sf.read(vocal)
    np.testing.assert_array_equal(actual, np.r_[samples[:2000], samples[8000:10000]])
    assert report["referenceTimelineRebuilt"]


def test_existing_effects_duplicate_output_channels_use_stereo(tmp_path: Path):
    source = tmp_path / "voice.wav"
    time = np.arange(8000) / 8000
    channels = np.column_stack(
        [0.1 * np.sin(2 * np.pi * 200 * time), *[0.1 * np.sin(2 * np.pi * 300 * time)] * 5]
    )
    sf.write(source, channels, 8000, subtype="FLOAT")
    render = MasterRender(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source,
        source,
        source,
        tmp_path / "out.wav",
        threading.Event(),
        source,
        True,
        False,
        False,
        (),
        None,
    )
    render.info, render.work = sf.info(source), tmp_path
    render._prepare_stems()
    assert render.output_channels == 2
    assert sf.info(source).channels == 6


def test_phrase_balance_does_not_follow_reference_singer_crescendos():
    voice = np.full(200, -26.0)
    backing = np.full(200, -25.0)
    gains, reliable = _balance_curve(voice, backing)
    assert reliable.all()
    assert np.ptp(gains) < 0.05


@pytest.mark.parametrize("difference", [-5.0, 5.0])
def test_mix_tone_corrects_excess_without_boosting_a_missing_vocal_band(difference):
    from backend.recordings.studio_voice import _cohesion_bands

    edges = np.array([150, 300, 600, 1200, 2400, 4800, 9600])
    centers = np.sqrt(edges[:-1] * edges[1:])
    ratios = np.zeros(6)
    ratios[3] = difference
    bands = _cohesion_bands(centers, ratios)
    assert bands == _cohesion_bands(centers, ratios + 12)
    if difference < 0:
        assert bands == []
    else:
        assert len(bands) == 1
        assert 1200 <= bands[0]["frequencyHz"] < 2400
        assert -1.5 <= bands[0]["gainDb"] < 0


def test_pitch_correction_keeps_vibrato_and_performance_octave():
    from types import SimpleNamespace
    from backend.ai.domain import PitchPoint
    from backend.recordings.studio_pitch import _pitch_curve

    times = np.arange(300) * 0.01
    notes = 57.5 + 0.2 * np.sin(2 * np.pi * 5 * times)
    actual = [PitchPoint(t, 440 * 2 ** ((n - 69) / 12), 1, True) for t, n in zip(times, notes)]
    reference = [PitchPoint(t, 440.0, 1, True) for t in times]
    render = SimpleNamespace(
        info=SimpleNamespace(duration=3),
        adjustments=[{"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}],
        pitch_adjustments=[],
        offset_result=(0, 1),
        reference_origin=0,
    )
    _, correction, voice, target, eligible = _pitch_curve(render, actual, reference)
    selected = eligible & (times > 0.7) & (times < 2.3)
    corrected = voice + correction

    def error(value):
        return abs(value - target - 12 * np.round((value - target) / 12))

    assert np.mean(error(corrected)[selected]) < np.mean(error(voice)[selected])
    assert np.ptp(corrected[selected]) >= 0.8 * np.ptp(voice[selected])
    assert np.max(abs(corrected - voice)) < 1


def test_pitch_render_preserves_audio_outside_corrected_notes(tmp_path: Path):
    from types import SimpleNamespace
    from backend.recordings.studio_pitch import _render_correction

    rate = 8000
    signal = np.repeat((0.1 * np.sin(2 * np.pi * 300 * np.arange(rate * 3) / rate))[:, None], 2, 1)
    source = tmp_path / "voice.wav"
    sf.write(source, signal, rate, subtype="FLOAT")

    class Renderer:
        def _mix(self, first, second, graph, output, cancel):
            samples, sr = sf.read(first, always_2d=True)
            sf.write(output[-1], samples * 0.5, sr, subtype="FLOAT")

    render = SimpleNamespace(
        work=tmp_path,
        vocal=source,
        cancel=threading.Event(),
        info=sf.info(source),
        renderer=Renderer(),
    )
    times = np.arange(300) / 100
    correction = np.where((times >= 1) & (times <= 2), 0.3, 0.0)
    output = _render_correction(render, times, correction)
    before, _ = sf.read(source, always_2d=True)
    after, _ = sf.read(output, always_2d=True)
    assert before.shape == after.shape
    np.testing.assert_array_equal(after[: rate // 2], before[: rate // 2])
    np.testing.assert_array_equal(after[-rate // 2 :], before[-rate // 2 :])
    np.testing.assert_allclose(after[rate + 100 : 2 * rate], before[rate + 100 : 2 * rate] * 0.5)


def test_diffuse_width_retains_mono_voice_and_total_energy(tmp_path: Path):
    from backend.recordings.studio_space import _match_stereo_width

    rate = 8000
    time = np.arange(rate * 2) / rate
    center = 0.1 * np.sin(2 * np.pi * 300 * time)
    side = 0.003 * np.sin(2 * np.pi * 700 * time)
    dry = np.column_stack((center, center))
    mixed = np.column_stack((center + side, center - side))
    source, output = tmp_path / "dry.wav", tmp_path / "wet.wav"
    sf.write(source, dry, rate, subtype="FLOAT")
    sf.write(output, mixed, rate, subtype="FLOAT")
    before, _ = sf.read(output, always_2d=True)
    report = _match_stereo_width(source, output, 0.1, threading.Event())
    after, sr = sf.read(output, always_2d=True)
    assert report["applied"]
    assert sr == rate and after.shape == before.shape
    np.testing.assert_allclose(np.sum(after**2), np.sum(before**2), rtol=1e-6)
    assert 0.04 < report["afterSideToMidRatio"] < 0.1
    assert np.corrcoef(after.mean(axis=1), center)[0, 1] > 0.99999
    assert np.corrcoef(after[:, 0], after[:, 1])[0, 1] > 0.8


def test_balance_tracks_accompaniment_gain_without_a_three_db_limit(tmp_path: Path):
    from backend.recordings.studio_calibration import calibrate_mix

    time = np.arange(8000 * 4) / 8000
    vocal, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    sf.write(vocal, 0.05 * np.sin(2 * np.pi * 500 * time), 8000, subtype="FLOAT")
    gains = []
    for shift in [0, 8]:
        music = 0.05 * 10 ** (shift / 20) * np.sin(2 * np.pi * 700 * time)
        sf.write(backing, music, 8000, subtype="FLOAT")
        gains.append(
            calibrate_mix(
                FfmpegStudioMasterRenderer(ProcessRunner()), vocal, backing, threading.Event(), {}
            )
        )
    assert gains[1] - gains[0] == pytest.approx(8, abs=0.01)


@pytest.mark.parametrize("calls", [0, 3])
@pytest.mark.parametrize("failed", [False, True])
def test_master_pitch_worker_stays_in_one_resource_scope(tmp_path: Path, calls, failed):
    from contextlib import contextmanager, nullcontext
    from types import SimpleNamespace
    from backend.ai.domain import PitchPoint
    from backend.recordings.start_studio_master import StartStudioMaster
    from backend.processing.compute_policy import ComputeDevice, ExecutionContext

    events = []
    points = (PitchPoint(0, 440, 0.9, True),)

    @contextmanager
    def reuse(cancel, execution):
        events.append("open")
        try:
            yield
        finally:
            events.append("close")

    provider = SimpleNamespace(
        reuse_pitch=reuse,
        pitch=lambda path, **kw: events.append("pitch") or points,
    )
    lease = SimpleNamespace(
        execution=ExecutionContext(ComputeDevice.CPU, 2),
        release=lambda: events.append("release"),
    )
    context = SimpleNamespace(cancel=threading.Event(), ensure_not_cancelled=lambda: None)
    settings = SimpleNamespace(selected_pitch_provider=None, compute_mode="CPU", cpu_threads=2)
    service = StartStudioMaster(
        None,
        None,
        None,
        SimpleNamespace(execute=lambda *a: provider),
        lambda: settings,
        SimpleNamespace(claim_provider=lambda *a, **kw: events.append("claim") or lease),
        None,
        None,
        None,
    )
    source = tmp_path / "voice.wav"
    source.write_bytes(b"audio")
    with pytest.raises(RuntimeError) if failed else nullcontext():
        with service._pitch_session(context) as analyze:
            for _ in range(calls):
                assert analyze(source) == points
            assert events == (["claim", "open"] + ["pitch"] * calls if calls else [])
            if failed:
                raise RuntimeError("render failed")
    assert events == (["claim", "open"] + ["pitch"] * calls + ["close", "release"] if calls else [])


def test_ambience_envelope_does_not_compute_discarded_cepstra(tmp_path: Path, monkeypatch):
    from backend.recordings import studio_space_analysis as analysis

    path = tmp_path / "reference.wav"
    samples = np.random.default_rng(35).normal(0, 0.1, (8000 * 5, 2))
    sf.write(path, samples, 8000, subtype="FLOAT")
    expected, _, _ = analysis._read_evidence(path, threading.Event())

    def unnecessary(*args):
        pytest.fail("envelope-only analysis must not compute spectral evidence")

    monkeypatch.setattr(analysis, "_sample_cepstra", unnecessary)
    levels, cepstra, positions = analysis._read_evidence(
        path, threading.Event(), include_cepstra=False
    )
    np.testing.assert_array_equal(levels, expected)
    assert cepstra.size == positions.size == 0


def test_scratch_wave_is_complete_and_sample_exact_before_next_stage(tmp_path: Path):
    from backend.recordings.studio_audio import _temporary_wave

    samples = np.random.default_rng(41).normal(0, 0.1, (8193, 2)).astype(np.float32)
    target = tmp_path / "scratch.wav"
    with _temporary_wave(target, samplerate=44100, channels=2) as output:
        output.write(samples[:4096])
        output.write(samples[4096:])
    actual, rate = sf.read(target, dtype="float32", always_2d=True)
    assert rate == 44100
    np.testing.assert_array_equal(actual, samples)
    assert sf.info(target).subtype == "FLOAT"
    target.unlink()
