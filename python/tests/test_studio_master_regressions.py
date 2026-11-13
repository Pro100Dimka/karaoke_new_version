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


def test_new_pipeline_does_not_call_legacy_gain_controllers(tmp_path, monkeypatch):
    import backend.recordings.studio_render as module
    from tests.test_studio_master_scenarios import scenario_audio

    def legacy(*args, **kwargs):
        raise AssertionError("Legacy gain controller was called")

    monkeypatch.setattr(FfmpegStudioMasterRenderer, "_balance_curve", staticmethod(legacy))
    monkeypatch.setattr(FfmpegStudioMasterRenderer, "_voice_filters", staticmethod(legacy))
    for name in ["control_vocal_peaks", "control_vocal_presence", "calibrate_mix"]:
        monkeypatch.setattr(module, name, legacy, raising=False)
    paths, adjustment = scenario_audio("steady", tmp_path)
    result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
        *paths[:4],
        tmp_path / "master.wav",
        threading.Event(),
        performance_mix=paths[4],
        exact_stems=True,
        adjustments=[adjustment],
    )
    assert result.processing["pipeline"] == "single-plan"
    assert result.processing["gainApplications"] == 1


@pytest.mark.parametrize("matching_project", [False, True])
def test_verified_project_backing_recovers_missing_stems_without_separation_leaks(
    tmp_path, monkeypatch, matching_project
):
    rate = 8000
    time = np.arange(rate * 10) / rate
    voice = np.repeat((0.06 * np.sin(2 * np.pi * 700 * time))[:, None], 2, axis=1)
    music = np.random.default_rng(28).normal(0, 0.004, voice.shape)
    project = music if matching_project else np.random.default_rng(29).normal(0, 0.004, voice.shape)
    separated = voice.copy()
    separated[(time >= 4) & (time < 6)] *= 0.1
    paths = [tmp_path / f"{name}.wav" for name in ["separated", "music", "ref", "project", "mix"]]
    for path, samples in zip(paths, [separated, music, voice, project, music + voice]):
        sf.write(path, samples, rate, subtype="FLOAT")
    analyze = MasterRender._analyze
    captured = {}

    def capture(render):
        captured["voice"] = sf.read(render.user_vocal, always_2d=True)[0]
        captured["music"] = sf.read(render.backing, always_2d=True)[0]
        return analyze(render)

    monkeypatch.setattr(MasterRender, "_analyze", capture)
    result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
        *paths[:4],
        tmp_path / "master.wav",
        threading.Event(),
        performance_mix=paths[4],
        adjustments=[{"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}],
    )
    if matching_project:
        np.testing.assert_allclose(captured["voice"], voice, atol=1e-7)
        np.testing.assert_allclose(captured["music"], music, atol=1e-7)
        assert result.processing["stemRecovery"]["method"] == "verified-project-subtraction"
    else:
        np.testing.assert_allclose(captured["voice"], separated, atol=1e-7)
        assert "stemRecovery" not in result.processing


@pytest.mark.parametrize("source_id", ["source", "master", "missing", None])
def test_repeated_master_uses_the_original_recording(tmp_path, source_id):
    from contextlib import contextmanager
    from datetime import datetime, UTC
    from types import SimpleNamespace
    from backend.recordings.domain import Recording
    from backend.recordings.start_studio_master import StartStudioMaster
    from backend.domain_errors import DomainError

    source = tmp_path / "source.flac"
    source.write_bytes(b"original")
    original = Recording("source", source, 4, 8000, 1, datetime.now(UTC))
    master = Recording(
        "master",
        tmp_path / "master.flac",
        4,
        8000,
        1,
        datetime.now(UTC),
        session_metadata={"studioMaster": {"sourceRecordingId": "source"}},
    )
    master.file_path.write_bytes(b"old master")
    records = {"source": original, "master": master}
    latest = Recording(
        "latest",
        tmp_path / "latest.flac",
        4,
        8000,
        1,
        datetime.now(UTC),
        session_metadata={"studioMaster": {"sourceRecordingId": "master"}},
    )
    records["latest"] = latest
    master.session_metadata["studioMaster"]["sourceRecordingId"] = source_id

    @contextmanager
    def transaction():
        yield SimpleNamespace(recordings=SimpleNamespace(get=records.get))

    service = StartStudioMaster.__new__(StartStudioMaster)
    service._uow = SimpleNamespace(create=transaction)
    if source_id == "source":
        assert service._recording("latest").recording_id == "source"
    else:
        code = {
            "master": "StudioMasterSourceCycle",
            "missing": "RecordingNotFound",
            None: "StudioMasterSourceMissing",
        }[source_id]
        with pytest.raises(DomainError) as error:
            service._recording("latest")
        assert error.value.code == code


def test_unmatched_reference_does_not_disable_the_new_plan(tmp_path, monkeypatch):
    from tests.test_studio_master_scenarios import scenario_audio

    monkeypatch.setattr(
        FfmpegStudioMasterRenderer, "_reference_offset", staticmethod(lambda *a: None)
    )
    paths, _ = scenario_audio("steady", tmp_path)
    result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
        *paths[:4],
        tmp_path / "master.wav",
        threading.Event(),
        performance_mix=paths[4],
        exact_stems=True,
        adjustments=[],
    )
    assert result.processing["gainApplications"] == 1
    assert result.processing["gainPlan"]["activeSeconds"] > 3


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


def test_new_plan_reads_stems_without_modifying_them(tmp_path: Path):
    from backend.recordings.studio_calibration import build_gain_plan

    time = np.arange(8000 * 4) / 8000
    vocal, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    sf.write(vocal, 0.02 * np.sin(2 * np.pi * 500 * time), 8000, subtype="FLOAT")
    sf.write(backing, 0.1 * np.sin(2 * np.pi * 700 * time), 8000, subtype="FLOAT")
    before = [path.read_bytes() for path in (vocal, backing)]
    plan = build_gain_plan(
        FfmpegStudioMasterRenderer(ProcessRunner()), vocal, backing, 0.5, threading.Event()
    )
    assert plan.report["globalGainDb"] > 3
    assert [path.read_bytes() for path in (vocal, backing)] == before


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
    master._separate(SimpleNamespace(file_path=recording, channels=1), tmp_path, Mock())
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


def test_old_space_estimators_cannot_modify_the_new_space_path(tmp_path, monkeypatch):
    import backend.recordings.studio_space as module

    def legacy(*args, **kwargs):
        raise AssertionError("Legacy space planner was called")

    for name in ["_estimate_ambience", "_match_stereo_width", "match_space"]:
        monkeypatch.setattr(module, name, legacy, raising=False)
    voice = tmp_path / "voice.wav"
    data = np.random.default_rng(12).normal(0, 0.03, 8000 * 4)
    sf.write(voice, data, 8000, subtype="FLOAT")
    target = tmp_path / "out.wav"
    report = apply_reference_space(
        FfmpegStudioMasterRenderer(ProcessRunner()), voice, voice, voice, target, threading.Event()
    )
    assert report["dryPreserved"]
    np.testing.assert_array_equal(
        sf.read(target, dtype="float32")[0], sf.read(voice, dtype="float32")[0]
    )


@pytest.mark.parametrize("masked, body_frequency", [(False, 150), (True, 150), (True, 400)])
def test_presence_eq_restores_words_without_turning_up_the_bass(
    tmp_path, monkeypatch, masked, body_frequency
):
    rate = 8000
    time = np.arange(rate * 8) / rate
    body = 0.08 if masked else 0.015
    voice = body * np.sin(2 * np.pi * body_frequency * time)
    voice += 0.035 * np.sin(2 * np.pi * 900 * time) + 0.02 * np.sin(2 * np.pi * 1800 * time)
    music = 0.05 * np.sin(2 * np.pi * 900 * time) + 0.03 * np.sin(2 * np.pi * 1800 * time)
    paths = [tmp_path / f"{name}.wav" for name in ["voice", "music", "ref", "original", "mix"]]
    for path, data in zip(paths, [voice, music, voice, music, voice + music]):
        sf.write(path, np.repeat(data[:, None], 2, axis=1), rate, subtype="FLOAT")
    deliver, captured = MasterRender._deliver, {}

    def capture(render):
        captured["voice"] = sf.read(render.balanced)[0][:, 0]
        deliver(render)

    monkeypatch.setattr(MasterRender, "_deliver", capture)
    result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
        *paths[:4],
        tmp_path / "master.wav",
        threading.Event(),
        performance_mix=paths[4],
        exact_stems=True,
        adjustments=[{"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}],
    )
    signal = captured["voice"][rate:-rate]
    axis = np.arange(len(signal)) / rate

    def amplitude(frequency):
        return 2 * abs(np.mean(signal * np.exp(-2j * np.pi * frequency * axis)))

    relative_change = 20 * np.log10(amplitude(900) / amplitude(body_frequency)) - 20 * np.log10(
        0.035 / body
    )
    assert result.processing["gainApplications"] == 1
    if masked:
        assert relative_change > 1.5
        assert any(band["gainDb"] > 0 for band in result.processing["spectralPlan"]["bands"])
    else:
        assert abs(relative_change) < 0.3


def test_pitch_transition_does_not_cancel_a_phase_shifted_syllable(tmp_path):
    from types import SimpleNamespace
    from backend.recordings.studio_pitch import _preserve_pitch_intervals

    rate = 16000
    time = np.arange(rate * 4) / rate
    voice = 0.05 * np.sin(2 * np.pi * 200 * time)
    source, candidate = tmp_path / "source.wav", tmp_path / "candidate.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    sf.write(candidate, -voice, rate, subtype="FLOAT")
    times = np.arange(400) / 100
    correction = np.interp(times, [0, 1, 1.4, 2.6, 3, 4], [0, 0, 0.2, 0.2, 0, 0])
    render = SimpleNamespace(vocal=source, work=tmp_path, cancel=threading.Event())
    _preserve_pitch_intervals(render, candidate, times, correction)
    actual, sr = sf.read(candidate)
    assert sr == rate and actual.shape == voice.shape
    window = rate // 20
    levels = np.mean(actual.reshape(-1, window) ** 2, axis=1)
    assert np.min(10 * np.log10(levels / np.mean(voice**2))) > -2
    assert np.max(abs(np.diff(actual))) < 1.5 * np.max(abs(np.diff(voice)))
    np.testing.assert_allclose(actual[:rate], voice[:rate], atol=1e-8)
    np.testing.assert_allclose(actual[rate * 3 :], voice[rate * 3 :], atol=1e-8)


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


def test_plan_tracks_accompaniment_gain_without_a_three_db_limit(tmp_path: Path):
    from backend.recordings.studio_calibration import build_gain_plan

    time = np.arange(8000 * 4) / 8000
    vocal, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    sf.write(vocal, 0.05 * np.sin(2 * np.pi * 500 * time), 8000, subtype="FLOAT")
    gains = []
    for shift in [0, 8]:
        sf.write(
            backing,
            0.05 * 10 ** (shift / 20) * np.sin(2 * np.pi * 700 * time),
            8000,
            subtype="FLOAT",
        )
        plan = build_gain_plan(
            FfmpegStudioMasterRenderer(ProcessRunner()), vocal, backing, 0.5, threading.Event()
        )
        gains.append(plan.report["globalGainDb"])
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
