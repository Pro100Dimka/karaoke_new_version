"""Independent reference layers are added to the user's voice on its own timeline."""

from types import SimpleNamespace
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_layer_types import VocalLayerRegion
from backend.recordings import studio_layers


def _render_context(tmp_path, **kwargs):
    rate = 44100
    time = np.arange(rate * 6) / rate
    own = 0.1 * np.sin(2 * np.pi * 240 * time)
    artist = 0.2 * np.sin(2 * np.pi * 370 * time)
    paths = [tmp_path / name for name in ("own.wav", "finished.wav", "reference.wav")]
    for path, samples in zip(paths, [own, own * 0.8, artist]):
        sf.write(path, np.column_stack([samples, samples]), rate, subtype="FLOAT")
    options = dict(
        renderer=FfmpegStudioMasterRenderer(ProcessRunner()),
        balanced=paths[1],
        space_reference=paths[2],
        info=sf.info(paths[0]),
        work=tmp_path,
        cancel=threading.Event(),
        pitch=lambda _: (),
        reference_pitch=(),
        reference_origin=0,
        process_voice=True,
        timing_known=True,
        pitch_adjustments=[dict(elapsedSeconds=0, sourceSeconds=0, playbackRate=1, keyShift=0)],
        offset_result=(0, 0),
        processing={},
    )
    options.update(kwargs)
    return SimpleNamespace(**options), paths[0]


def _power_near(audio, rate, hz):
    spectrum = np.fft.rfft(audio * np.hanning(len(audio)))
    frequencies = np.fft.rfftfreq(len(audio), 1 / rate)
    return float(np.sum(abs(spectrum[abs(frequencies - hz) < 3]) ** 2))


def test_reference_plan_adds_octave_of_user_and_never_original_singer(tmp_path, monkeypatch):
    context, direct = _render_context(tmp_path)
    original = sf.read(context.balanced, always_2d=True)[0]
    inputs = [path.read_bytes() for path in (direct, context.balanced, context.space_reference)]
    monkeypatch.setattr(
        studio_layers,
        "analyze_reference_layers",
        lambda *_: ([VocalLayerRegion(2, 4, "octave", 0.25, semitones=-12)], {}),
    )
    studio_layers.apply_reference_layers(context, direct)
    samples, rate = sf.read(context.balanced, always_2d=True)
    wet = (samples - original).mean(1)
    middle = wet[round(2.4 * rate) : round(3.6 * rate)]
    assert _power_near(middle, rate, 120) > _power_near(middle, rate, 185) * 100
    assert np.sqrt(np.mean(middle**2)) > 0.005
    assert np.max(abs(wet[: round(1.8 * rate)])) < 1e-7
    assert np.max(abs(wet[round(4.2 * rate) :])) < 1e-7
    assert context.processing["vocalLayers"]["applied"] is True
    assert inputs == [
        path.read_bytes() for path in (direct, tmp_path / "finished.wav", context.space_reference)
    ]


@pytest.mark.parametrize(
    "options, reason",
    [
        ({"pitch": None}, "single-performer-analysis-unavailable"),
        ({"process_voice": False}, "existing-effects-preserved"),
        ({"timing_known": False}, "unconfirmed-reference-timeline"),
    ],
)
def test_unconfirmed_or_existing_capture_does_not_call_layer_analysis(
    tmp_path, monkeypatch, options, reason
):
    context, direct = _render_context(tmp_path, **options)
    before = context.balanced

    def forbidden(*_):
        pytest.fail("Layer analysis must not bypass capture/room/timeline guard")

    monkeypatch.setattr(studio_layers, "analyze_reference_layers", forbidden)
    studio_layers.apply_reference_layers(context, direct)
    assert context.balanced == before
    assert context.processing["vocalLayers"]["reason"] == reason


def test_unperformed_reference_chorus_does_not_add_a_voice(tmp_path, monkeypatch):
    context, direct = _render_context(tmp_path)
    before = context.balanced
    monkeypatch.setattr(
        studio_layers,
        "analyze_reference_layers",
        lambda *_: ([VocalLayerRegion(8, 10, "octave", 0.25, semitones=-12)], {}),
    )
    studio_layers.apply_reference_layers(context, direct)
    assert context.balanced == before
    assert context.processing["vocalLayers"]["applied"] is False


def test_original_seek_map_is_passed_even_if_balance_timeline_was_rebuilt(tmp_path, monkeypatch):
    context, direct = _render_context(tmp_path)
    context.pitch_adjustments = [
        dict(elapsedSeconds=0, sourceSeconds=2, playbackRate=1, keyShift=5)
    ]
    context.adjustments = [dict(elapsedSeconds=0, sourceSeconds=0, playbackRate=1, keyShift=0)]
    monkeypatch.setattr(
        studio_layers,
        "analyze_reference_layers",
        lambda *_: ([VocalLayerRegion(3, 4, "octave", 0.25, semitones=-12)], {}),
    )
    captured = []

    def inspect_plan(renderer, dry, finished, target, regions, cancel):
        captured.extend(regions)
        return finished, {"applied": False}

    monkeypatch.setattr(studio_layers, "render_vocal_layers", inspect_plan)
    studio_layers.apply_reference_layers(context, direct)
    assert [(region.start, region.end, region.semitones) for region in captured] == [(1, 2, -12)]
