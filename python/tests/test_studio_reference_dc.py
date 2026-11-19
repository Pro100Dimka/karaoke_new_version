"""Inaudible separator DC cannot veto otherwise verified reference placement."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_reference_level import analyze_reference_level


def _signals(rate, antiphase=False):
    time = np.arange(rate * 12) / rate
    voice = 0.08 * np.sin(2 * np.pi * 173 * time)
    voice += 0.03 * np.sin(2 * np.pi * 519 * time)
    voice *= 0.8 + 0.2 * np.sin(2 * np.pi * 0.37 * time)
    voice = np.column_stack((voice, -voice if antiphase else voice * 0.8))
    backing = 0.1 * np.column_stack(
        (np.sin(2 * np.pi * 809 * time), np.sin(2 * np.pi * 1237 * time))
    )
    voice[time >= 10] = 0
    backing[time >= 10] = 0
    return voice, backing


def _write(root, voice, backing, source, rate):
    # Independent source/stem/channel offsets make the quiet held-out tail
    # disagree in DC while its audible source components remain identical.
    signals = (
        source + [-0.0002, 0.0004],
        voice * 0.3 + [0.0003, -0.0005],
        backing * 0.6 + [-0.0004, 0.0002],
    )
    paths = [root / f"{name}.wav" for name in ("source", "voice", "backing")]
    for path, signal in zip(paths, signals):
        sf.write(path, signal, rate, subtype="FLOAT")
    return paths


def _analyze(root, paths):
    return analyze_reference_level(
        FfmpegStudioMasterRenderer(ProcessRunner()), *paths, root, threading.Event()
    )


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("antiphase", [False, True])
def test_independent_channel_dc_and_quiet_tail_preserve_known_source_balance(
    tmp_path, rate, antiphase
):
    voice, backing = _signals(rate, antiphase)
    paths = _write(tmp_path, voice, backing, voice + backing, rate)
    before = [path.read_bytes() for path in paths]

    evidence = _analyze(tmp_path, paths)

    assert evidence.report["status"] == "verified"
    assert evidence.correction_db == pytest.approx(20 * np.log10(0.6 / 0.3), abs=0.01)
    assert evidence.report["vocalCoefficient"] == pytest.approx(1 / 0.3, rel=0.001)
    assert evidence.report["backingCoefficient"] == pytest.approx(1 / 0.6, rel=0.001)
    assert evidence.report["validatedWindows"] == 6
    assert [path.read_bytes() for path in paths] == before


@pytest.mark.parametrize(
    "defect", ["missing_voice", "silent_channel", "quiet_tail_tone", "nonlinear"]
)
def test_dc_invariance_does_not_hide_missing_audible_content(tmp_path, defect):
    rate = 44100
    voice, backing = _signals(rate)
    source = voice + backing
    if defect == "missing_voice":
        source[3 * rate : 4 * rate] = backing[3 * rate : 4 * rate]
    elif defect == "silent_channel":
        source[5 * rate : 6 * rate, 1] = 0
    elif defect == "quiet_tail_tone":
        tone = 0.003 * np.sin(2 * np.pi * 50 * np.arange(rate) / rate)
        voice[11 * rate :, 1] = tone
    else:
        source = np.tanh(source * 12) / 12

    evidence = _analyze(tmp_path, _write(tmp_path, voice, backing, source, rate))

    assert evidence.correction_db is None
    assert evidence.report["status"] == "rejected"


def test_dc_alone_cannot_provide_independent_stem_evidence(tmp_path):
    silence = np.zeros((44100 * 12, 2))
    evidence = _analyze(tmp_path, _write(tmp_path, silence, silence, silence, 44100))
    assert evidence.correction_db is None
    assert evidence.report["status"] == "rejected"
