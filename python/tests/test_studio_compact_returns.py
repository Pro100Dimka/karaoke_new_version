"""A local return stores its full causal support on the unchanged global timeline."""

from types import SimpleNamespace
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings import studio_regional_space as space
from backend.recordings.studio_parallel import render_execution
from backend.recordings.studio_regional_returns import AmbienceRegion, convolve_return
from backend.recordings.studio_return_audio import (
    compact_field_envelopes,
    convolve_compact_return,
    read_return,
)
from backend.recordings.studio_space_analysis import _field_envelopes


def _regions():
    return [
        AmbienceRegion(
            start, start + 2, np.exp(-np.arange(31) / 7), (500, 3500), 1, 0.12, 0.01, 0.9, "fixture"
        )
        for start in (1.0, 20.0, 60.0)
    ]


@pytest.mark.parametrize("measure", ["stored", "decoded"])
def test_regional_returns_do_not_process_unrelated_sections(tmp_path, monkeypatch, measure):
    count, rate = 32768 * 20 + 137, 8000
    source, target = tmp_path / "voice.wav", tmp_path / "mix.wav"
    sf.write(source, np.random.default_rng(821).normal(0, 0.1, (count, 2)), rate, subtype="FLOAT")
    observed, original_mix, original_read = {}, space._mix_buses, sf.SoundFile.read

    def capture_mix(*args, **kwargs):
        observed["stored"] = sum(sf.info(bus[1]).frames for bus in args[2])
        return original_mix(*args, **kwargs)

    def count_reads(reader, *args, **kwargs):
        block = original_read(reader, *args, **kwargs)
        if str(reader.name) == str(source):
            observed["decoded"] = observed.get("decoded", 0) + len(block)
        return block

    monkeypatch.setattr(space, "plan_regional_ambience", lambda *args, **kwargs: _regions())
    monkeypatch.setattr(space, "plan_coherent_echoes", lambda *args: [])
    monkeypatch.setattr(space, "_mix_buses", capture_mix)
    monkeypatch.setattr(sf.SoundFile, "read", count_reads)
    space.render_regional_sends(
        source,
        target,
        threading.Event(),
        reference=source,
        arrangement=SimpleNamespace(duration_seconds=count / rate),
        base_report={},
        legacy=[],
        existing_wet=0.03,
        legacy_duck=lambda block: np.ones((len(block), 1)),
    )
    limit = count if measure == "stored" else count * 3
    assert observed[measure] < limit


def _return_fixture(rate, channels, kind):
    count = 32768 * 20 + 713
    rng = np.random.default_rng(673)
    samples = rng.normal(0, 0.1, (count, channels)).astype(np.float32)
    start, end = 12.2 * 32768 / rate, 13.1 * 32768 / rate
    if kind == "partial":
        start, end = 18.8 * 32768 / rate, count / rate
    elif kind == "start":
        start, end = 0.0, 0.7 * 32768 / rate
    elif kind == "tiny":
        samples *= 1e-30
    elif kind == "opposite-phase":
        samples[:, 1] = -samples[:, 0]
    impulse = rng.normal(0, 0.02, (round(rate * 0.64), 2))
    region = AmbienceRegion(
        start,
        end,
        np.ones(31),
        (500, 3500),
        1,
        0.15,
        0.01,
        0.9,
        "fixture",
        valid_start=0,
        valid_end=count / rate,
    )
    return samples, impulse, region


def _virtual_pcm(path, span):
    blocks = []
    with sf.SoundFile(path) as source:
        for offset in range(0, span.total_frames, 32768):
            count = min(32768, span.total_frames - offset)
            block = read_return(source, span, offset, count)
            blocks.append(np.zeros((count, 2)) if block is None else block)
    return np.concatenate(blocks).astype(np.float32)


@pytest.mark.parametrize("rate,channels", [(8000, 1), (44100, 2), (96000, 2)])
@pytest.mark.parametrize("kind", ["middle", "start", "partial", "tiny", "opposite-phase"])
def test_compact_return_keeps_every_dense_pcm_and_calibration_sample(
    tmp_path, rate, channels, kind
):
    if channels == 1 and kind == "opposite-phase":
        return
    samples, impulse, region = _return_fixture(rate, channels, kind)
    voice, dense, compact = (tmp_path / name for name in ("voice.wav", "dense.wav", "compact.wav"))
    sf.write(voice, samples, rate, subtype="FLOAT")
    cancel = threading.Event()
    convolve_return(voice, dense, region, impulse, cancel)
    span = convolve_compact_return(voice, compact, region, impulse, cancel)
    expected, _ = sf.read(dense, dtype="float32", always_2d=True)
    np.testing.assert_array_equal(
        _virtual_pcm(compact, span).view(np.uint32), expected.view(np.uint32)
    )
    assert span.offset_frames % 32768 == 0
    assert sf.info(compact).frames < len(samples)
    end = round(region.end * 50)
    for band in (0, 1):
        expected_field = _field_envelopes(dense, cancel, band_index=band)
        actual_field = compact_field_envelopes(compact, span, band, end, cancel)
        np.testing.assert_array_equal(
            actual_field[:end].view(np.uint64), expected_field[:end].view(np.uint64)
        )


def _render_known_returns(source, target, legacy, cancel):
    return space.render_regional_sends(
        source,
        target,
        cancel,
        reference=source,
        arrangement=SimpleNamespace(duration_seconds=sf.info(source).duration),
        base_report={},
        legacy=legacy,
        existing_wet=0.03,
        legacy_duck=lambda block: np.full((len(block), 1), 0.4),
    )


@pytest.mark.parametrize("legacy_present", [False, True])
def test_compact_buses_keep_full_dense_mix_and_reports(tmp_path, monkeypatch, legacy_present):
    source, dense, compact = (tmp_path / name for name in ("voice.wav", "dense.wav", "compact.wav"))
    samples = np.random.default_rng(961).normal(0, 0.1, (32768 * 20 + 137, 2))
    sf.write(source, samples, 8000, subtype="FLOAT")
    monkeypatch.setattr(space, "plan_regional_ambience", lambda *args, **kwargs: _regions())
    monkeypatch.setattr(space, "plan_coherent_echoes", lambda *args: [])
    legacy = [("delay", source, 0.03)] if legacy_present else []
    original = space._regional_buses

    def dense_buses(*args, **kwargs):
        kwargs.pop("compact", None)
        return original(*args, **kwargs)

    cancel = threading.Event()
    with monkeypatch.context() as baseline:
        baseline.setattr(space, "_regional_buses", dense_buses)
        expected_report = _render_known_returns(source, dense, legacy, cancel)
    with render_execution(cancel, workers=3):
        actual_report = _render_known_returns(source, compact, legacy, cancel)
    expected, _ = sf.read(dense, dtype="float32", always_2d=True)
    actual, _ = sf.read(compact, dtype="float32", always_2d=True)
    np.testing.assert_array_equal(actual.view(np.uint32), expected.view(np.uint32))
    assert actual_report == expected_report
