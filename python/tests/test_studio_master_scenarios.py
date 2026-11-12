"""Deterministic content checks, separate from listening and real-recording evidence."""

from pathlib import Path
import json
import threading
import hashlib
import numpy as np
import pytest
import soundfile as sf
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
def test_master_scenario(name: str, tmp_path: Path):
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
    assert processing["compressionSource"] == "performance-vocal"
    if name == "partial":
        assert processing["adaptive"]["referenceTimingTrusted"]
