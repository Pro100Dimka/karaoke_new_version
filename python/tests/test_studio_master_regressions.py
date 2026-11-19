from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_adaptive_delivery import deliver_master
from backend.recordings.studio_adaptive_mix import plan_balance
from backend.recordings.studio_adaptive_space import render_sends
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
    assert result.processing["pipeline"] == "adaptive-studio-v1"
    assert result.processing["gainPlan"]["gainApplications"] == 1


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
        FfmpegStudioMasterRenderer, "_reference_offset", staticmethod(lambda *a: (0.0, 0.0))
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
    assert result.processing["gainPlan"]["gainApplications"] == 1
    assert result.processing["gainPlan"]["activeSeconds"] > 3
    assert result.processing["gainPlan"]["referenceUsed"] is False
    assert result.processing["backingSource"] == "recorded-accompaniment"
    assert result.processing["qualityControl"]["verified"]


def test_reference_section_excludes_unperformed_song_and_rejects_seeks():
    adjustments = [{"elapsedSeconds": 0, "sourceSeconds": 40, "playbackRate": 1, "keyShift": 0}]
    assert reference_section(adjustments, 10) == (40, 50)
    assert reference_section([], 10) is None
    adjustments.append({"elapsedSeconds": 5, "sourceSeconds": 90, "playbackRate": 1, "keyShift": 0})
    assert reference_section(adjustments, 10) is None


def test_initial_balance_preserves_capture_without_a_reference(tmp_path):
    time = np.arange(8000 * 4) / 8000
    paths = [tmp_path / name for name in ("voice.wav", "backing.wav")]
    for path, frequency in zip(paths, (500, 900)):
        sf.write(path, 0.03 * np.sin(2 * np.pi * frequency * time), 8000, subtype="FLOAT")
    plan = plan_balance(*paths, None, None, threading.Event())
    assert plan.active.all()
    assert plan.report["referenceUsed"] is False
    np.testing.assert_allclose(plan.gains, 0, atol=0.01)


def test_peak_limiter_preserves_timeline_and_tail(tmp_path: Path):
    rate = 8000
    voice = np.zeros(rate)
    voice[50] = 0.2
    voice[-10] = 0.1
    v, b, output = (tmp_path / name for name in ("voice.wav", "backing.wav", "out.wav"))
    sf.write(v, voice, rate, subtype="FLOAT")
    sf.write(b, np.zeros_like(voice), rate, subtype="FLOAT")
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    delivery = deliver_master(renderer, v, output, threading.Event(), reference=v)
    actual, _ = sf.read(output)
    assert actual.shape == voice.shape
    # Oversampled limiting includes anti-alias filtering. Test the observable
    # timeline and null against the resampler alone: an inactive limiter must not
    # shift, truncate or attenuate the filtered impulse response at either boundary.
    resampled = tmp_path / "resampler-only.wav"
    renderer._mix(
        v,
        v,
        "[0:a]aresample=32000,aresample=8000[out]",
        ["-c:a", "pcm_f32le", str(resampled)],
        threading.Event(),
    )
    expected, _ = sf.read(resampled)
    gain = 10 ** (delivery["globalGainDb"] / 20)
    np.testing.assert_allclose(actual, expected * gain, atol=2e-6)
    assert np.argmax(abs(actual[: rate // 2])) == 50
    assert np.argmax(abs(actual[rate // 2 :])) + rate // 2 == rate - 10
    assert delivery["truePeakDbtp"] <= -1


def test_stereo_width_alone_does_not_synthesize_reverb(tmp_path: Path):
    rng = np.random.default_rng(77)
    rate = 8000
    dry = rng.normal(0, 0.04, (rate * 8, 1))
    dry = np.repeat(dry, 2, axis=1)
    reference = dry + rng.normal(0, 0.02, dry.shape)
    v, r, output = (tmp_path / name for name in ("voice.wav", "reference.wav", "out.wav"))
    sf.write(v, dry, rate, subtype="FLOAT")
    sf.write(r, reference, rate, subtype="FLOAT")
    report = render_sends(v, v, output, threading.Event(), reference=r)
    assert report["status"] == "no-supported-addition"
    actual, _ = sf.read(output, always_2d=True)
    np.testing.assert_allclose(actual, dry, atol=1e-8)


def test_reference_balance_is_independent_of_channel_count(tmp_path: Path):
    rate = 8000
    signal = np.sin(2 * np.pi * 700 * np.arange(rate * 8) / rate) * 0.1
    vocal, backing = tmp_path / "mono.wav", tmp_path / "stereo.wav"
    sf.write(vocal, signal, rate, subtype="FLOAT")
    sf.write(backing, np.repeat(signal[:, None], 2, axis=1), rate, subtype="FLOAT")
    plan = plan_balance(vocal, backing, vocal, backing, threading.Event())
    assert plan.report["referenceUsed"] is True
    assert abs(plan.report["referenceTargetRatioDb"]) < 0.01
    np.testing.assert_allclose(plan.gains, 0, atol=0.01)


@pytest.mark.parametrize("source_suffix", [".wav", ".flac"])
@pytest.mark.parametrize("dry_state", ["ready", "incomplete", "absent"])
def test_new_plan_reads_stems_without_modifying_them(tmp_path: Path, source_suffix, dry_state):
    from backend.recordings.studio_audio import recording_stems

    time = np.arange(8000 * 4) / 8000
    native = tmp_path / "recording.wav"
    source = native.with_suffix(source_suffix)
    vocal, backing = (Path(str(native) + suffix) for suffix in (".vocal.wav", ".backing.wav"))
    sf.write(vocal, 0.02 * np.sin(2 * np.pi * 500 * time), 8000, subtype="FLOAT")
    sf.write(backing, 0.1 * np.sin(2 * np.pi * 700 * time), 8000, subtype="FLOAT")
    sf.write(
        source,
        sf.read(vocal)[0] + sf.read(backing)[0],
        8000,
        subtype="PCM_24" if source_suffix == ".flac" else "FLOAT",
    )
    selected_voice = vocal
    if dry_state != "absent":
        dry = Path(str(native) + (".dry.wav" if dry_state == "ready" else ".dry-incomplete.wav"))
        dry.write_bytes(vocal.read_bytes())
        if dry_state == "ready":
            selected_voice = dry
    original_files = {path: path.read_bytes() for path in tmp_path.iterdir()}
    assert recording_stems(source, prefer_dry=True) == (selected_voice, backing)
    assert recording_stems(source) == (vocal, backing)
    plan = plan_balance(vocal, backing, backing, backing, threading.Event())
    assert plan.report["medianGainDb"] > 3
    assert plan.report["referenceUsed"] is True
    assert {path: path.read_bytes() for path in original_files} == original_files

    from contextlib import contextmanager
    from datetime import datetime, UTC
    from types import SimpleNamespace
    from backend.infrastructure.recording_archive import RecordingArchive
    from backend.recordings.domain import Recording
    from backend.analysis.domain import AnalysisState

    archived = source.with_suffix(".flac")
    sf.write(archived, sf.read(source)[0], 8000, subtype="PCM_24")
    recording = Recording("take", source, 4, 8000, 1, datetime.now(UTC))

    @contextmanager
    def transaction():
        yield SimpleNamespace(
            recordings=SimpleNamespace(
                get=lambda _: recording,
                update_file=lambda *args: None,
            ),
            commit=lambda: None,
        )

    archive = RecordingArchive.__new__(RecordingArchive)
    archive._root, archive._cancel = tmp_path.resolve(), threading.Event()
    archive._uow = SimpleNamespace(create=transaction)
    archive._analyses = lambda _: [SimpleNamespace(state=AnalysisState.SUCCEEDED)]
    marker = tmp_path / "archive-pending.json"
    marker.write_text("{}")
    archive._publish("take", [(recording, archived)], marker)
    assert recording_stems(archived, prefer_dry=True) == (selected_voice, backing)
    for path in [selected_voice, backing]:
        assert path.read_bytes() == original_files[path]


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


def test_compression_controls_excess_dynamics_even_with_a_steady_reference(tmp_path):
    from backend.recordings.studio_adaptive_dynamics import compressor_plan
    from backend.recordings.studio_adaptive_features import analyze_voice

    rate = 8000
    time = np.arange(rate * 5) / rate
    recorded = np.sin(2 * np.pi * 500 * time) * 10 ** ((-30 + 20 * (time % 1)) / 20)
    reference = np.sin(2 * np.pi * 500 * time) * 0.1
    paths = [tmp_path / name for name in ("voice.wav", "reference.wav")]
    for path, data in zip(paths, (recorded, reference)):
        sf.write(path, data, rate, subtype="FLOAT")
    actual, expected = (analyze_voice(path, threading.Event()) for path in paths)
    graph, report = compressor_plan(actual, fast=False, reference=expected)
    assert graph is not None
    assert report["applied"] and report["ratio"] > 1
    assert report["plannedUpperReductionDb"] <= 3


@pytest.mark.parametrize("speed,key", [(1, 0), (1.25, 2), (0.75, -3)])
def test_seek_reference_contains_only_performed_sections(tmp_path: Path, speed, key):
    from backend.recordings.studio_sources import render_timeline

    path = tmp_path / "reference.wav"
    samples = np.arange(16000, dtype=np.float32) / 16000
    sf.write(path, samples, 8000, subtype="FLOAT")
    adjustments = [
        {"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0},
        {"elapsedSeconds": 0.25, "sourceSeconds": 1, "playbackRate": 1, "keyShift": 0},
    ]
    vocal = tmp_path / "performed-reference.wav"
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    coverage = render_timeline(
        renderer, path, vocal, threading.Event(), adjustments, frames=4000, rate=8000, channels=1
    )
    actual, _ = sf.read(vocal)
    np.testing.assert_array_equal(actual, np.r_[samples[:2000], samples[8000:10000]])
    assert coverage == 1

    time = np.arange(8000) / 8000
    tones = np.sin(2 * np.pi * np.where(time < 0.5, 400, 800) * time) * 0.1
    sf.write(path, tones, 8000, subtype="FLOAT")
    adjustments = [
        {"elapsedSeconds": 0, "sourceSeconds": 0.2, "playbackRate": speed, "keyShift": key}
    ]
    render_timeline(
        renderer, path, vocal, threading.Event(), adjustments, frames=4000, rate=8000, channels=1
    )
    changed, rate = sf.read(vocal)
    assert rate == 8000 and changed.shape == actual.shape
    for start, end, frequency in [(0.03, 0.13, 400), (0.43, 0.49, 800)]:
        block = changed[round(start * rate) : round(end * rate)]
        spectrum = abs(np.fft.rfft(block * np.hanning(len(block)), n=16384))
        peak = np.fft.rfftfreq(16384, 1 / rate)[np.argmax(spectrum)]
        assert peak == pytest.approx(frequency * 2 ** (key / 12), abs=3)


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
    render.info, render.work, render.processing = sf.info(source), tmp_path, {}
    render._prepare_stems()
    assert render.output_channels == 2
    assert sf.info(source).channels == 6


def test_phrase_balance_does_not_invent_crescendos_without_a_reference(tmp_path):
    time = np.arange(8000 * 6) / 8000
    paths = [tmp_path / name for name in ("voice.wav", "backing.wav")]
    for path, level, frequency in zip(paths, (-26, -25), (500, 900)):
        sf.write(
            path, 10 ** (level / 20) * np.sin(2 * np.pi * frequency * time), 8000, subtype="FLOAT"
        )
    plan = plan_balance(*paths, None, None, threading.Event())
    assert plan.active.all()
    assert np.ptp(plan.gains) < 0.05


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
    report = render_sends(voice, voice, target, threading.Event(), reference=voice)
    assert report["dryPreserved"]
    np.testing.assert_array_equal(
        sf.read(target, dtype="float32")[0], sf.read(voice, dtype="float32")[0]
    )


@pytest.mark.parametrize(
    "masked, body_frequency, changing_density",
    [
        (False, 150, False),
        (True, 150, False),
        (True, 400, False),
        (True, 150, True),
    ],
)
def test_adaptive_mix_preserves_word_prominence_without_turning_up_the_bass(
    tmp_path, monkeypatch, masked, body_frequency, changing_density
):
    import backend.recordings.studio_adaptive_mix as mix_module

    rate = 8000
    time = np.arange(rate * 8) / rate
    # Bass coloration must not make a broadband balance controller turn down words
    # that already have the reference's correct level against the accompaniment.
    body = 0.12 if masked else 0.015
    voice = body * np.sin(2 * np.pi * body_frequency * time)
    voice += 0.035 * np.sin(2 * np.pi * 900 * time) + 0.02 * np.sin(2 * np.pi * 1800 * time)
    reference = voice + (0.015 - body) * np.sin(2 * np.pi * body_frequency * time)
    music = 0.05 * np.sin(2 * np.pi * 900 * time) + 0.03 * np.sin(2 * np.pi * 1800 * time)
    if changing_density:
        music[time >= 4] = 0.05 * np.sin(2 * np.pi * 150 * time[time >= 4])
    paths = [tmp_path / f"{name}.wav" for name in ["voice", "music", "ref", "original", "mix"]]
    for path, data in zip(paths, [voice, music, reference, music, voice + music]):
        sf.write(path, np.repeat(data[:, None], 2, axis=1), rate, subtype="FLOAT")
    deliver, captured = MasterRender._deliver, {}

    def capture(render):
        captured["voice"] = sf.read(render.balanced)[0][:, 0]
        deliver(render)

    monkeypatch.setattr(MasterRender, "_deliver", capture)
    duck = mix_module.duck_backing
    apply_gain = mix_module._write_gain_envelope

    def capture_balanced(source, target, times, gains, cancel):
        apply_gain(source, target, times, gains, cancel)
        captured["mixed_voice"] = sf.read(target)[0][:, 0]

    monkeypatch.setattr(mix_module, "_write_gain_envelope", capture_balanced)

    def capture_backing(vocal, backing, target, cancel):
        report = duck(vocal, backing, target, cancel)
        captured["backing"] = sf.read(target)[0][:, 0]
        return report

    monkeypatch.setattr(mix_module, "duck_backing", capture_backing)
    result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
        *paths[:4],
        tmp_path / "master.wav",
        threading.Event(),
        performance_mix=paths[4],
        exact_stems=True,
        adjustments=[{"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}],
    )
    signal = captured["voice"][rate : 3 * rate]
    axis = np.arange(len(signal)) / rate

    def amplitude(samples, frequency):
        return 2 * abs(np.mean(samples * np.exp(-2j * np.pi * frequency * axis)))

    relative_change = 20 * np.log10(
        amplitude(signal, 900) / amplitude(signal, body_frequency)
    ) - 20 * np.log10(0.035 / body)
    assert result.processing["gainPlan"]["gainApplications"] == 1
    assert relative_change > -0.3, "Processing must not emphasize bass over the words"
    if not masked:
        assert abs(relative_change) < 0.3
    for frequency in (900, 1800):
        expected = 20 * np.log10(
            amplitude(reference[rate : 3 * rate], frequency)
            / amplitude(music[rate : 3 * rate], frequency)
        )
        delivered = 20 * np.log10(
            amplitude(captured["mixed_voice"][rate : 3 * rate], frequency)
            / amplitude(captured["backing"][rate : 3 * rate], frequency)
        )
        assert abs(delivered - expected) <= 3, "Broadband matching must not bury the words"
    if changing_density:
        # Dynamic EQ must restore the accompaniment when the spectral conflict ends.
        np.testing.assert_allclose(
            captured["backing"][5 * rate : 7 * rate], music[5 * rate : 7 * rate], atol=1e-8
        )


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
def test_master_pitch_calls_local_analysis_lazily_without_provider_resources(
    tmp_path: Path, monkeypatch, calls, failed
):
    from contextlib import nullcontext
    from types import SimpleNamespace
    from backend.ai.domain import PitchPoint
    from backend.recordings import start_studio_master as module

    events = []
    points = (PitchPoint(0, 440, 0.9, True),)
    context = SimpleNamespace(cancel=threading.Event(), ensure_not_cancelled=lambda: None)
    source = tmp_path / "voice.wav"

    def analyze(path, cancel):
        assert path == source and cancel is context.cancel
        events.append("analyze")
        return points

    def external(*args, **kwargs):
        pytest.fail("Offline master pitch must not resolve or allocate a neural provider")

    monkeypatch.setattr(module, "analyze_pitch", analyze)
    service = module.StartStudioMaster(
        None,
        None,
        None,
        SimpleNamespace(execute=external),
        external,
        SimpleNamespace(claim_provider=external),
        None,
        None,
        None,
    )
    with pytest.raises(RuntimeError, match="render failed") if failed else nullcontext():
        with service._pitch_session(context) as pitch:
            assert events == []
            for _ in range(calls):
                assert pitch(source) == points
            assert events == ["analyze"] * calls
            if failed:
                raise RuntimeError("render failed")
    assert events == ["analyze"] * calls


@pytest.mark.parametrize("cancel_before_first_call", [False, True])
def test_master_pitch_checks_cancellation_before_every_local_analysis(
    tmp_path: Path, monkeypatch, cancel_before_first_call
):
    from types import SimpleNamespace
    from backend.domain_errors import DomainError
    from backend.recordings import start_studio_master as module
    from backend.recordings.studio_audio import _check_cancel

    cancel, calls = threading.Event(), []
    context = SimpleNamespace(cancel=cancel, ensure_not_cancelled=lambda: _check_cancel(cancel))

    def analyze(path, event):
        assert event is cancel
        calls.append(path)
        return ()

    monkeypatch.setattr(module, "analyze_pitch", analyze)
    service = module.StartStudioMaster.__new__(module.StartStudioMaster)
    source = tmp_path / "voice.wav"
    with service._pitch_session(context) as pitch:
        if not cancel_before_first_call:
            assert pitch(source) == ()
        cancel.set()
        with pytest.raises(DomainError) as error:
            pitch(source)
        assert error.value.code == "ProcessCancelled"
    assert calls == ([] if cancel_before_first_call else [source])


def test_master_pitch_propagates_local_analysis_failure(tmp_path: Path, monkeypatch):
    from types import SimpleNamespace
    from backend.recordings import start_studio_master as module

    failure = RuntimeError("local pitch analysis failed")

    def analyze(path, cancel):
        raise failure

    monkeypatch.setattr(module, "analyze_pitch", analyze)
    service = module.StartStudioMaster.__new__(module.StartStudioMaster)
    context = SimpleNamespace(cancel=threading.Event(), ensure_not_cancelled=lambda: None)
    with service._pitch_session(context) as pitch:
        with pytest.raises(RuntimeError) as error:
            pitch(tmp_path / "voice.wav")
    assert error.value is failure


@pytest.mark.parametrize("shared_room", [False, True])
def test_master_only_passes_pitch_analysis_to_solo_recordings(tmp_path: Path, shared_room):
    from contextlib import contextmanager
    from types import SimpleNamespace
    from backend.recordings.start_studio_master import StartStudioMaster

    calls = []

    def analyze(path):
        calls.append(path)
        return ()

    @contextmanager
    def session(context):
        yield analyze

    expected = object()
    stems = tmp_path / "recording.dry.wav", tmp_path / "recording.backing.wav"
    recording = SimpleNamespace(
        session_metadata={"roomPerformance": {}} if shared_room else {},
        file_path=tmp_path / "recording.wav",
    )

    def render(*args, **kwargs):
        if shared_room:
            assert kwargs["pitch"] is None
        else:
            assert kwargs["pitch"] is analyze
            kwargs["pitch"](stems[0])
        return expected

    service = StartStudioMaster.__new__(StartStudioMaster)
    service._pitch_session = session
    service._project_identity = lambda recording: ("song", 1)
    service._original_mix = lambda *args: None
    service._projects = SimpleNamespace(artifact_path=lambda *args: tmp_path / args[-1])
    service._renderer = SimpleNamespace(render=render)
    context = SimpleNamespace(cancel=threading.Event(), progress=lambda *args: None)
    result = service._render(recording, stems, True, tmp_path / "master.wav", context)
    assert result is expected
    assert calls == ([] if shared_room else [stems[0]])


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


@pytest.mark.parametrize("error,corrects", [(0.2, False), (0.8, True), (2.0, True)])
def test_natural_pitch_policy_leaves_small_deviations_and_limits_real_corrections(error, corrects):
    from types import SimpleNamespace
    from backend.ai.domain import PitchPoint
    from backend.recordings.studio_pitch import _pitch_curve

    times = np.arange(400) * 0.01
    actual = [PitchPoint(t, 440 * 2 ** (error / 12), 1, True) for t in times]
    reference = [PitchPoint(t, 440, 1, True) for t in times]
    render = SimpleNamespace(
        info=SimpleNamespace(duration=4),
        adjustments=[],
        pitch_adjustments=[],
        offset_result=(0, 1),
        reference_origin=0,
    )
    _, correction, _, _, _ = _pitch_curve(render, actual, reference)
    assert np.max(abs(correction)) <= 0.35
    if corrects:
        assert np.max(abs(correction)) > 0.1
        assert np.mean(abs(correction)) < error * 0.4
    else:
        np.testing.assert_array_equal(correction, 0)


@pytest.mark.parametrize("dropouts", [False, True])
def test_pitch_quality_rejects_local_level_holes_but_allows_a_fixed_gain(tmp_path, dropouts):
    from types import SimpleNamespace
    from backend.recordings.studio_pitch import _pitch_dynamics_quality

    rate = 8000
    axis = np.arange(rate * 4) / rate
    dry = 0.05 * np.sin(2 * np.pi * 220 * axis)
    wet = dry * 1.2
    if dropouts:
        wet[(axis > 1) & (axis < 2)] *= 0.1
    source, candidate = tmp_path / "dry.wav", tmp_path / "wet.wav"
    sf.write(source, dry, rate, subtype="FLOAT")
    sf.write(candidate, wet, rate, subtype="FLOAT")
    report = _pitch_dynamics_quality(
        SimpleNamespace(vocal=source, cancel=threading.Event()), candidate
    )
    assert report["accepted"] is (not dropouts)


def test_added_reverb_is_gentler_without_reducing_direct_voice(tmp_path, monkeypatch):
    from backend.recordings import studio_adaptive_space

    rate = 8000
    samples = np.zeros(rate * 4)
    samples[rate] = 0.2
    voice, reference, target = [tmp_path / name for name in ("voice.wav", "ref.wav", "spatial.wav")]
    sf.write(voice, samples, rate, subtype="FLOAT")
    sf.write(reference, samples, rate, subtype="FLOAT")
    monkeypatch.setattr(
        studio_adaptive_space,
        "_tail_evidence",
        lambda path, cancel: (0.8, 0.1, 4) if path == reference else (0.0, 0.0, 0),
    )
    report = render_sends(voice, voice, target, threading.Event(), reference=reference)
    actual, _ = sf.read(target)
    assert report["applied"]
    assert actual[rate] == pytest.approx(samples[rate], abs=1e-8)
    np.testing.assert_allclose(actual[: rate + 100], samples[: rate + 100], atol=1e-8)
    wet_ratio = np.linalg.norm(actual - samples) / np.linalg.norm(samples)
    assert wet_ratio == pytest.approx(0.1, abs=0.005)
    assert report["decaySeconds"] == 0.8


@pytest.mark.parametrize("dry", [False, True])
@pytest.mark.parametrize("existing_wet", [0.0, 0.1])
def test_reference_space_checks_missing_effects_for_both_voice_sources(
    tmp_path, monkeypatch, dry, existing_wet
):
    import backend.recordings.studio_adaptive_space as module

    rate = 8000
    time = np.arange(rate * 4) / rate
    voice = 0.03 * np.sin(2 * np.pi * 500 * time) * ((time > 0.5) & (time < 2.5))
    balanced = tmp_path / "balanced.wav"
    reference = tmp_path / "reference.wav"
    target = tmp_path / "spatial-voice.wav"
    sf.write(balanced, voice, rate, subtype="FLOAT")
    sf.write(reference, voice, rate, subtype="FLOAT")
    before = balanced.read_bytes()
    measured = []

    def evidence(path, cancel):
        measured.append(path)
        return 0.6, 0.1 if path == reference else existing_wet, 4

    monkeypatch.setattr(module, "_tail_evidence", evidence)
    report = render_sends(
        balanced, balanced, target, threading.Event(), reference=reference, recorded_is_dry=dry
    )
    assert measured == [reference, balanced]
    assert balanced.read_bytes() == before
    assert report["dryPreserved"] is True
    assert report["existingWetRatio"] == existing_wet
    actual, _ = sf.read(target)
    assert actual.shape == voice.shape
    if existing_wet == 0:
        assert report["applied"] is True
        assert np.linalg.norm(actual - voice) > 0
    else:
        assert report["applied"] is False
        np.testing.assert_array_equal(actual, sf.read(balanced)[0])
