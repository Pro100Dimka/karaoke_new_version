from __future__ import annotations

import threading
from pathlib import Path

import pytest

from backend.infrastructure.process_runner import ProcessResult
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


def test_studio_master_raises_quiet_vocal_to_the_original_song_balance(
    tmp_path: Path,
) -> None:
    # Performance: vocal is 15 dB below its backing. Original: vocal is 6 dB below backing.
    runner = MasteringProcessRunner([-30.0, -15.0, -18.0, -12.0])
    renderer = FfmpegStudioMasterRenderer(runner)  # type: ignore[arg-type]
    paths = [tmp_path / name for name in ("voice.wav", "backing.wav", "reference.wav", "original.wav")]

    balance = renderer.render(*paths, tmp_path / "master.wav", threading.Event())

    assert balance.vocal_gain_db == pytest.approx(9.0)
    assert "volume=9.000dB,alimiter=limit=0.794" in runner.filter_graph
    assert "volume=0dB[backing]" in runner.filter_graph
    assert runner.level_filters == ["ebur128=framelog=verbose"] * 4
    assert "equalizer=" in runner.filter_graph
    assert "aexciter=" not in runner.filter_graph
    assert "stereotools=" in runner.filter_graph
    assert "measured_I=-17.2" in runner.filter_graph
    assert str(paths[3]) in runner.render_command
    assert str(paths[1]) not in runner.render_command
    assert runner.filter_graph.endswith("alimiter=limit=0.891:attack=5:release=50[out]")
    assert runner.mastering_passes == 2
