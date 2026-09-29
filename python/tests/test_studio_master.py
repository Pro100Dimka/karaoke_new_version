from __future__ import annotations

import threading
from pathlib import Path

import pytest

from backend.infrastructure.process_runner import ProcessResult
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


class MasteringProcessRunner:
    def __init__(self, levels: list[float]) -> None:
        self.levels = levels
        self.filter_graph = ""
        self.mastering_passes = 0

    def run(self, command, **kwargs) -> ProcessResult:
        del kwargs
        if "volumedetect" in command:
            level = self.levels.pop(0)
            return ProcessResult(0, b"", f"mean_volume: {level} dB\n".encode())
        if "print_format=json" in " ".join(command):
            self.mastering_passes += 1
            return ProcessResult(
                0,
                b"",
                b'{"input_i":"-17.2","input_tp":"-2.1","input_lra":"5.4",'
                b'"input_thresh":"-27.3","target_offset":"0.2"}',
            )
        self.mastering_passes += 1
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
    assert "volume=9.000dB[vocal]" in runner.filter_graph
    assert "equalizer=" in runner.filter_graph
    assert "aexciter=" in runner.filter_graph
    assert "stereotools=" in runner.filter_graph
    assert "measured_I=-17.2" in runner.filter_graph
    assert runner.mastering_passes == 2
