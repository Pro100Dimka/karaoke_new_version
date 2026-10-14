from __future__ import annotations

import json
import threading
import time
from typing import Sequence

from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.infrastructure.runtime_probe import SystemRuntimeProbe, forget_torch_facts


class _SlowTorch(ProcessRunner):
    """PyTorch answers only once released, like its first import after installation."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.torch_probes = 0

    def run(self, command: Sequence[str], **_: object) -> ProcessResult:  # type: ignore[override]
        if command[0] == "ffmpeg":
            return ProcessResult(0, b"ffmpeg version 8.0 Copyright", b"")
        if command[0] == "nvidia-smi":
            return ProcessResult(1, b"", b"")
        self.torch_probes += 1
        self.release.wait(10)
        facts = {"version": "2.11.0+cu130", "cuda": True, "runtime": "13.0", "gpu": "RTX", "total": 8, "free": 7}
        return ProcessResult(0, json.dumps(facts).encode(), b"")


def test_start_up_reports_at_once_and_a_job_gets_the_gpu_once_probed() -> None:
    forget_torch_facts()
    processes = _SlowTorch()
    probe = SystemRuntimeProbe(processes)
    try:
        started = time.perf_counter()
        now = probe.without_waiting().inspect()
        assert time.perf_counter() - started < 1
        assert now.cuda_available is False and now.ffmpeg_version == "8.0"

        job: list[bool] = []
        waiting = threading.Thread(target=lambda: job.append(probe.inspect().cuda_available))
        waiting.start()
        waiting.join(timeout=0.2)
        assert waiting.is_alive() and not job  # a job waits for the probe that is already running
        processes.release.set()
        waiting.join(10)

        assert job == [True]
        assert processes.torch_probes == 1  # the job joined the start-up probe instead of a second one
        assert probe.without_waiting().inspect().gpu_name == "RTX"
    finally:
        processes.release.set()
        forget_torch_facts()
