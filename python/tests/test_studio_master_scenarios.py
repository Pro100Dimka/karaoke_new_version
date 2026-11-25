"""Deterministic content checks, separate from listening and real-recording evidence."""

import hashlib
import json
import threading
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, correlate, correlation_lags, sosfiltfilt

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer

SCENARIOS = (
    "intro-climax",
    "steady",
    "space",
    "no-echo",
    "partial",
    "quiet",
    "loud",
    "pauses",
    "dry",
    "vocal",
)


def scenario_audio(name: str, root: Path) -> tuple[list[Path], dict[str, object]]:
    root.mkdir(parents=True, exist_ok=True)
    rate = 8000
    time = np.arange(rate * 12) / rate
    phrase = 0.3 + 0.7 * np.sin(np.pi * time / 3) ** 2
    voice = 0.08 * phrase * np.sin(2 * np.pi * (240 * time + 0.6 * np.sin(time)))
    backing = 0.08 * np.sin(2 * np.pi * 120 * time)
    if name == "intro-climax":
        backing *= np.where(time < 6, 0.15, 2)
    reference = voice.copy()
    if name == "space":
        delay = round(0.237 * rate)
        reference[delay:] += 0.25 * voice[:-delay]
    if name == "pauses":
        voice[(time > 4) & (time < 9)] = 0
    voice *= {"quiet": 0.15, "loud": 3.0}.get(name, 1)
    start = 4 if name == "partial" else 0
    end = 10 if name == "partial" else 12
    recorded, music = voice[start * rate : end * rate], backing[start * rate : end * rate]
    paths = [
        root / (label + ".wav") for label in ("voice", "backing", "reference", "original", "mix")
    ]
    for path, samples in zip(
        paths, (recorded, music, reference, backing, recorded + music), strict=True
    ):
        sf.write(path, samples, rate, subtype="FLOAT")
    return paths, {"elapsedSeconds": 0, "sourceSeconds": start, "playbackRate": 1, "keyShift": 0}


@pytest.mark.parametrize("name", SCENARIOS)
def test_master_scenario(name: str, tmp_path: Path, monkeypatch):
    from backend.recordings import studio_adaptive_mix

    write_gain = studio_adaptive_mix._write_gain_envelope
    gain_errors = []

    def verify_gain(source, target, times, gains, cancel):
        write_gain(source, target, times, gains, cancel)
        before_gain, sr = sf.read(source, always_2d=True)
        after_gain, _ = sf.read(target, always_2d=True)
        size = round(sr * 0.1)
        windows = len(before_gain) // size
        powers = [
            np.mean(samples[: windows * size].reshape(windows, size, -1) ** 2, axis=(1, 2))
            for samples in (before_gain, after_gain)
        ]
        active = powers[0] > max(float(np.max(powers[0])) * 1e-4, 1e-12)
        measured = 10 * np.log10(np.maximum(powers[1], 1e-12) / np.maximum(powers[0], 1e-12))
        planned = np.interp((np.arange(windows) + 0.5) * 0.1, times, gains)
        gain_errors.append(float(np.percentile(abs(measured - planned)[active], 90)))

    monkeypatch.setattr(studio_adaptive_mix, "_write_gain_envelope", verify_gain)
    paths, adjustment = scenario_audio(name, tmp_path)
    before = [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]
    output = tmp_path / "master.wav"
    report = (
        FfmpegStudioMasterRenderer(ProcessRunner())
        .render(
            *paths[:4],
            output,
            threading.Event(),
            performance_mix=paths[4],
            exact_stems=True,
            process_voice=name != "vocal",
            match_recording_loudness=True,
            adjustments=[adjustment],
        )
        .payload()
    )
    (tmp_path / "parameters-and-results.json").write_text(
        json.dumps({"scenario": name, "adjustment": adjustment, "report": report}, indent=2)
    )
    actual, rate = sf.read(output)
    original, _ = sf.read(paths[4])
    assert rate == 8000 and actual.shape == original.shape
    assert np.isfinite(actual).all() and np.sqrt(np.mean(actual**2)) > 0.001
    assert np.max(np.abs(actual)) < 0.9
    assert before == [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]
    processing = report["processing"]
    assert processing["qualityControl"]["verified"]
    assert processing["delivery"]["truePeakDbtp"] <= -1
    assert processing["pipeline"] == "adaptive-studio-v2"
    assert processing["arrangement"]["frames"] == len(original)
    assert processing["arrangement"]["timebase"] == "performed-timeline-seconds-from-zero"
    assert processing["gainPlan"]["gainApplications"] == 1
    assert len(gain_errors) == 1 and gain_errors[0] < 3
    assert processing["vocalChain"]["order"] == [
        "subtractive-eq",
        "peak-compressor",
        "leveling-compressor",
        "deesser",
        "color-eq",
        "saturation",
    ]
    assert processing["mix"]["order"] == [
        "sectionBalance",
        "dynamicBackingEq",
        "parallelSpaceSends",
        "masterGlue",
        "truePeakLimiter",
    ]
    assert processing["preparation"]["cleanup"]["removedSeconds"] == 0
    assert processing["delivery"]["verified"]
    if name == "partial":
        assert processing["gainPlan"]["activeSeconds"] > 3


@pytest.mark.parametrize("singers", [2, 3, 4])
def test_shared_vocal_master_preserves_every_singer_and_their_timing(
    tmp_path, monkeypatch, singers
):
    from backend.recordings import studio_adaptive_mix

    balanced = {}
    write_gain = studio_adaptive_mix._write_gain_envelope

    def capture_balance(source, target, times, gains, cancel):
        write_gain(source, target, times, gains, cancel)
        balanced["vocal"] = sf.read(target)[0]

    monkeypatch.setattr(studio_adaptive_mix, "_write_gain_envelope", capture_balance)
    rate = 8000
    time = np.arange(rate * 12) / rate
    frequencies = (330, 510, 730, 970)[:singers]
    voices = []
    for index, frequency in enumerate(frequencies):
        envelope = np.maximum(0, np.sin(np.pi * (time - index * 0.31) / 1.7)) ** 4
        envelope *= (time > 0.7 + index * 0.31) & (time < 10.5)
        voices.append(
            0.06 * 10 ** (-index * 6 / 20) * envelope * np.sin(2 * np.pi * frequency * time)
        )
    vocal = np.sum(voices, axis=0)
    backing = 0.04 * np.sin(2 * np.pi * 110 * time)
    paths = [
        tmp_path / (name + ".wav") for name in ("vocal", "backing", "reference", "original", "mix")
    ]
    for path, samples in zip(
        paths, (vocal, backing, voices[0], backing, vocal + backing), strict=True
    ):
        sf.write(path, samples, rate, subtype="FLOAT")
    target = tmp_path / "master.wav"
    result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
        *paths[:4],
        target,
        threading.Event(),
        performance_mix=paths[4],
        exact_stems=True,
        process_voice=False,
        match_recording_loudness=True,
        adjustments=[{"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}],
    )
    master, actual_rate = sf.read(target)
    assert actual_rate == rate and master.shape == vocal.shape
    assert result.processing["voiceShiftMs"] == 0, result.processing["timing"]
    for frequency in frequencies:
        band = butter(4, (frequency - 25, frequency + 25), fs=rate, btype="bandpass", output="sos")
        actual = sosfiltfilt(band, master)
        expected = sosfiltfilt(band, balanced["vocal"])
        scores = correlate(actual, expected, method="fft")
        peak = int(np.argmax(scores))
        lag = correlation_lags(len(actual), len(expected))[peak]
        assert abs(lag) <= rate * 0.03, (frequency, lag / rate)
        assert scores[peak] / (np.linalg.norm(actual) * np.linalg.norm(expected)) > 0.85
        assert np.sqrt(np.mean(actual**2)) > 0.1 * np.sqrt(np.mean(expected**2))
    assert result.processing["vocalSource"] == "existing-effects"


@pytest.mark.parametrize("singers", [2, 3, 4])
def test_room_master_balances_each_singers_capture_gain_independently(
    tmp_path, singers, monkeypatch
):
    from backend.recordings import studio_voice_analysis

    analyze = studio_voice_analysis.analyze_voice
    references = []

    def measured(path, cancel):
        if path.name == "reference-timeline.wav":
            references.append(path)
        return analyze(path, cancel)

    monkeypatch.setattr(studio_voice_analysis, "analyze_voice", measured)
    paths, adjustment = scenario_audio("steady", tmp_path)
    original, rate = sf.read(paths[0])
    header = (
        "wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,timelineSampleRateHz\n"
    )
    timeline = header + f"0,480000,{len(original)},{rate},1,48000\n"
    Path(str(paths[4]) + ".timeline.csv").write_text(timeline)
    sources = {}
    for index in range(singers):
        source = tmp_path / f"singer-{index}"
        source.mkdir()
        sf.write(source / "voice.wav", original * 10 ** (-index * 6 / 20), rate, subtype="FLOAT")
        (source / "timeline.csv").write_text(timeline)
        sources[f"singer-{index}"] = [source]
    target = tmp_path / "room-master.wav"
    result = FfmpegStudioMasterRenderer(ProcessRunner()).render(
        *paths[:4],
        target,
        threading.Event(),
        performance_mix=paths[4],
        exact_stems=True,
        process_voice=True,
        match_recording_loudness=True,
        adjustments=[adjustment],
        room_sources=sources,
        workers=4,
    )
    reports = result.processing["roomSingers"]
    assert set(reports) == set(sources)
    assert result.processing["voiceShiftMs"] == 0
    assert result.processing["synchronization"] == "native-room-recording-clocks"
    levels = [item["outputLevelDb"] for item in reports.values()]
    assert max(levels) - min(levels) < 1.5, reports
    assert all(item["vocalChain"]["order"] for item in reports.values())
    assert len(references) == 1
    info = sf.info(target)
    assert (info.frames, info.samplerate, info.channels) == (len(original), rate, 1)
