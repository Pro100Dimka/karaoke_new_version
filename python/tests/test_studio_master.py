from __future__ import annotations

import threading
import json
import re
from pathlib import Path

import pytest

from backend.infrastructure.process_runner import ProcessResult
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


class MasteringProcessRunner:
    def __init__(self, levels: list[float]) -> None:
        self.levels = levels
        self.level_filters: list[str] = []
        self.filter_graph = ""
        self.render_command: list[str] = []
        self.mastering_passes = 0

    def run(self, command, **kwargs) -> ProcessResult:
        del kwargs
        if any("volumedetect" in part or "ebur128" in part for part in command):
            level = self.levels.pop(0)
            audio_filter = command[command.index("-af") + 1]
            self.level_filters.append(audio_filter)
            return ProcessResult(0, b"", f"I: {level} LUFS\n".encode())
        if "print_format=json" in " ".join(command):
            self.mastering_passes += 1
            return ProcessResult(
                0,
                b"",
                b'{"input_i":"-17.2","input_tp":"-2.1","input_lra":"5.4",'
                b'"input_thresh":"-27.3","target_offset":"0.2"}',
            )
        self.mastering_passes += 1
        self.render_command = list(command)
        self.filter_graph = command[command.index("-filter_complex") + 1]
        Path(command[-1]).write_bytes(b"master")
        return ProcessResult(0, b"", b"")


def test_normal_take_balance_finishes_in_one_render_without_remastering(tmp_path):
    runner = MasteringProcessRunner([-18, -12, -18, -12])
    renderer = FfmpegStudioMasterRenderer(runner)
    renderer.render(
        *[
            tmp_path / name
            for name in ("vocal.wav", "backing.wav", "reference.wav", "original.wav")
        ],
        tmp_path / "balanced.wav",
        threading.Event(),
        performance_mix=tmp_path / "take.wav",
        enhance=False,
    )
    assert runner.mastering_passes == 1
    assert "loudnorm" not in runner.filter_graph
    assert "equalizer" not in runner.filter_graph
    assert "alimiter" in runner.filter_graph


def test_a_silent_microphone_keeps_the_take_without_leaving_a_backing_copy(tmp_path):
    import numpy as np
    import soundfile as sf

    path = tmp_path / "recording.wav"
    music = 0.1 * np.sin(2 * np.pi * 220 * np.arange(32000) / 16000)
    sf.write(path, music, 16000)
    backing = Path(str(path) + ".backing.wav")
    backing.write_bytes(path.read_bytes())
    captured = path.read_bytes()
    FfmpegStudioMasterRenderer(ProcessRunner()).balance_recording(path, path, backing)
    assert path.read_bytes() == captured
    assert not backing.exists()


@pytest.mark.parametrize("level", [-70.0, -70.1, float("-inf"), float("inf")])
def test_mastering_rejects_the_ebur128_silence_floor_before_calculating_gain(tmp_path, level):
    from backend.domain_errors import DependencyError

    runner = MasteringProcessRunner([level])
    renderer = FfmpegStudioMasterRenderer(runner)
    with pytest.raises(DependencyError) as error:
        renderer._integrated_loudness(tmp_path / "silent.wav", threading.Event())
    assert error.value.code == "StudioMasterSilentTrack"
    assert runner.mastering_passes == 0


def test_mastering_keeps_measurable_quiet_audio_above_the_ebur128_floor(tmp_path):
    renderer = FfmpegStudioMasterRenderer(MasteringProcessRunner([-69.9]))
    assert renderer._integrated_loudness(tmp_path / "quiet.wav", threading.Event()) == -69.9


def test_studio_master_raises_quiet_vocal_to_the_original_song_balance(
    tmp_path: Path,
) -> None:
    # Voice is 18 dB below the recorded backing; the original song has a 6 dB difference.
    runner = MasteringProcessRunner([-30.0, -12.0, -18.0, -12.0])
    renderer = FfmpegStudioMasterRenderer(runner)  # type: ignore[arg-type]
    paths = [
        tmp_path / name for name in ("voice.wav", "backing.wav", "reference.wav", "original.wav")
    ]

    performance = tmp_path / "take.wav"
    balance = renderer.render(
        *paths,
        tmp_path / "master.wav",
        threading.Event(),
        performance_mix=performance,
    )

    assert balance.vocal_gain_db == pytest.approx(12.0)
    assert "volume=2.981071706[boost]" in runner.filter_graph
    assert "duration=first" in runner.filter_graph
    assert runner.level_filters == ["ebur128=framelog=verbose"] * 4
    assert "equalizer=" in runner.filter_graph
    assert "aexciter=" not in runner.filter_graph
    assert "afftdn=" not in runner.filter_graph
    assert "measured_I=-17.2" in runner.filter_graph
    assert str(performance) in runner.render_command
    assert str(paths[0]) in runner.render_command
    assert str(paths[3]) not in runner.render_command
    assert str(paths[1]) not in runner.render_command
    assert runner.filter_graph.endswith("alimiter=limit=0.891:attack=5:release=50:level=false[out]")
    assert runner.mastering_passes == 2


@pytest.mark.parametrize(
    ("voice_level", "music_level", "reference_level"),
    [
        (0.1, 0.3, 0.1),
        (0.01, 0.1, 0.1),
        (0.5, 0.1, 0.1),
        (0.1, 0.03, 0.03),
    ],
)
@pytest.mark.parametrize("normal_recording", [False, True])
def test_studio_master_preserves_loudness_and_the_requested_vocal_balance(
    tmp_path: Path,
    voice_level: float,
    music_level: float,
    reference_level: float,
    normal_recording: bool,
) -> None:
    import numpy as np
    import soundfile as sf

    time = np.arange(48000 * 4) / 48000
    vocal, backing, reference = [
        tmp_path / name for name in ("voice.wav", "backing.wav", "reference.wav")
    ]
    for path, frequency, amplitude in (
        (vocal, 440, voice_level),
        (backing, 220, music_level),
        (reference, 440, reference_level),
    ):
        samples = amplitude * np.sin(2 * np.pi * frequency * time)
        sf.write(path, np.column_stack((samples, samples)), 48000)
    target = tmp_path / "master.wav"
    performance = tmp_path / "take.wav"
    sf.write(performance, sf.read(vocal)[0] + sf.read(backing)[0], 48000)
    runner = ProcessRunner()

    renderer = FfmpegStudioMasterRenderer(runner)
    if normal_recording:
        sf.write(Path(str(performance) + ".backing.wav"), sf.read(backing)[0], 48000)
        renderer.balance_recording(performance, reference, backing)
        assert performance.with_name("take.original.wav").is_file()
        target = performance
        assert sf.info(target).frames == 4 * 48000
    else:
        renderer.render(
            vocal,
            backing,
            reference,
            backing,
            target,
            threading.Event(),
            performance_mix=performance,
        )

    result = runner.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(target),
            "-af",
            "loudnorm=I=-14:TP=-1:print_format=json",
            "-f",
            "null",
            "-",
        ],
        timeout_seconds=30,
    )
    measured = json.loads(re.search(rb'\{\s*"input_i".*?\}', result.stderr, re.S)[0])
    if not normal_recording:
        assert float(measured["input_i"]) == pytest.approx(-14, abs=0.25)
    assert float(measured["input_tp"]) <= -0.9
    samples, rate = sf.read(target, always_2d=True)
    mono = samples[rate : rate * 3].mean(axis=1)
    axis = np.arange(len(mono)) / rate
    levels = [
        abs(np.mean(mono * np.exp(-2j * np.pi * frequency * axis))) for frequency in (440, 220)
    ]
    actual_ratio = 20 * np.log10(levels[0] / levels[1])
    expected_ratio = 20 * np.log10(reference_level / music_level)
    assert actual_ratio == pytest.approx(expected_ratio, abs=0.8)
