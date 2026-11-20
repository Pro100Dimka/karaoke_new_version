"""Regional returns need no detector or duck envelope when legacy sends are absent."""

from contextlib import ExitStack
from types import SimpleNamespace
import math
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings import studio_adaptive_space as sends
from backend.recordings import studio_regional_space as regional
from backend.recordings.studio_audio import _temporary_wave
from backend.recordings.studio_return_audio import ReturnSpan


def _fixture(tmp_path):
    count, rate = 32768 * 4 + 137, 8000
    rng = np.random.default_rng(10473)
    source, room = tmp_path / "voice.wav", tmp_path / "room.wav"
    voice = rng.normal(0, 0.1, (count, 2)).astype(np.float32)
    voice[32768 : 32768 * 2] *= 0.001
    returned = rng.normal(0, 0.03, (32768 + 701, 2)).astype(np.float32)
    sf.write(source, voice, rate, subtype="FLOAT")
    sf.write(room, returned, rate, subtype="FLOAT")
    buses = [("ambience", room, 0.17, 0.24), ("ambience", room, 0.07, -0.02)]
    return source, buses, {room: ReturnSpan(32768, count)}


def _original_mix(source, target, buses, legacy, compact, ducker):
    """Frozen pre-guard reduction order, including the otherwise unused detector."""
    info = sf.info(source)
    energy, mono_energy = {}, {}
    dry = dry_mono = 0.0
    with ExitStack() as stack:
        voice = stack.enter_context(sf.SoundFile(source))
        rooms = [
            (name, stack.enter_context(sf.SoundFile(path)), mid, side, compact.get(path))
            for name, path, mid, side in buses
        ]
        old = [(name, stack.enter_context(sf.SoundFile(path)), gain) for name, path, gain in legacy]
        output = stack.enter_context(
            _temporary_wave(target, samplerate=info.samplerate, channels=info.channels)
        )
        offset = 0
        for block in voice.blocks(blocksize=32768, always_2d=True):
            ducking = ducker.envelope(block)
            returns = regional._read_regional(rooms, len(ducking), offset)
            for name, reader, gain in old:
                added = reader.read(len(ducking), always_2d=True) * gain * ducking
                returns[name] = returns.get(name, np.zeros_like(added)) + added
            wet = np.zeros((len(ducking), info.channels))
            for name, added in returns.items():
                wet += added
                energy[name] = energy.get(name, 0.0) + float(np.sum(added**2))
                mono_energy[name] = mono_energy.get(name, 0.0) + float(
                    np.sum(added.mean(axis=1) ** 2)
                )
            dry += float(np.sum(block**2))
            dry_mono += float(np.sum(block.mean(axis=1) ** 2))
            output.write(block + wet)
            offset += len(block)
    return energy, dry, dry_mono, mono_energy


def _forbidden(*_args, **_kwargs):
    pytest.fail("An absent legacy return must not calculate a duck envelope or detector")


def test_regional_returns_without_legacy_skip_activity_and_ducker_factory(tmp_path, monkeypatch):
    source, _, _ = _fixture(tmp_path)
    captured = {}
    report = {"guardFixture": True}

    def render(*args, **kwargs):
        captured.update(kwargs)
        return report

    monkeypatch.setattr(sends, "_voice_activity_level", _forbidden)
    monkeypatch.setattr(sends, "WetDucker", _forbidden)
    monkeypatch.setattr(sends, "render_regional_sends", render)
    plan = sends.SendPlan(0.0, 0.0, None, 0.0, 0.0, 0.0, {"qualifiedExistingWetRatio": 0.03})
    actual = sends._regional_returns(
        source, tmp_path / "target.wav", plan, None, SimpleNamespace(), [], threading.Event()
    )
    assert actual is report
    assert captured["legacy_duck"] is None
    assert captured["legacy"] == []
    assert captured["existing_wet"] == math.hypot(0.03, 0.0)


@pytest.mark.parametrize("legacy_present", [False, True])
def test_guard_keeps_exact_mix_energy_report_and_existing_duck_state(tmp_path, legacy_present):
    source, buses, compact = _fixture(tmp_path)
    legacy = [("ambience", source, 0.021), ("delay", source, 0.04)] if legacy_present else []
    before, after = tmp_path / "before.wav", tmp_path / "after.wav"
    baseline_ducker = sends.WetDucker(8000, 0.08)
    expected = _original_mix(source, before, buses, legacy, compact, baseline_ducker)
    ducker = sends.WetDucker(8000, 0.08)
    sizes = []

    def envelope(block):
        sizes.append(len(block))
        return ducker.envelope(block)

    actual = regional._mix_buses(
        source,
        after,
        buses,
        legacy,
        threading.Event(),
        envelope if legacy_present else _forbidden,
        compact=compact,
    )
    expected_pcm, _ = sf.read(before, dtype="float32", always_2d=True)
    actual_pcm, _ = sf.read(after, dtype="float32", always_2d=True)
    np.testing.assert_array_equal(actual_pcm.view(np.uint32), expected_pcm.view(np.uint32))
    assert actual == expected
    assert regional._report({}, [], *actual) == regional._report({}, [], *expected)
    if legacy_present:
        assert sizes == [32768] * 4 + [137]
        assert (ducker.activity_state, ducker.gain_state) == (
            baseline_ducker.activity_state,
            baseline_ducker.gain_state,
        )


@pytest.mark.parametrize("legacy_present", [False, True])
def test_regional_mix_guard_preserves_cancellation(tmp_path, legacy_present):
    source, buses, compact = _fixture(tmp_path)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError, match="cancelled"):
        regional._mix_buses(
            source,
            tmp_path / "cancelled.wav",
            buses,
            [("delay", source, 0.04)] if legacy_present else [],
            cancel,
            _forbidden,
            compact=compact,
        )
