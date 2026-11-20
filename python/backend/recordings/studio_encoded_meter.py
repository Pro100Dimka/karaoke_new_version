"""Optional FFmpeg loopback metering of the actual encoded output packets."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable
import threading

from backend.infrastructure.process_runner import ProcessResult, ProcessRunner


@runtime_checkable
class EncodedMeterRenderer(Protocol):
    def _mix_encoded(
        self,
        first: Path,
        second: Path,
        filter_graph: str,
        output: list[str],
        cancel: threading.Event,
    ) -> ProcessResult | None: ...


class EncodedMeterSupport:
    def __init__(self, runner: ProcessRunner, executable: str) -> None:
        self._runner, self._executable = runner, executable
        self._available: bool | None = None

    def available(self, cancel: threading.Event) -> bool:
        if self._available is None:
            # Parse the option before -version exits, without opening audio or outputs.
            # Older FFmpeg builds reject -dec and retain the separate encoded-file meter.
            result = self._runner.run(
                [self._executable, "-hide_banner", "-dec", "0:0", "-version"],
                timeout_seconds=30,
                cancel=cancel,
            )
            self._available = result.exit_code == 0
        return self._available


def encoded_meter_output(output: list[str]) -> list[str]:
    # A separate filtergraph consumes decoder packets after pcm_s24le quantization.
    # Measuring a pre-encoder float split would not verify the delivered PCM.
    return [
        *output,
        "-threads",
        "1",
        "-dec",
        "0:0",
        "-filter_complex_threads",
        "1",
        "-filter_complex",
        "[dec:0]ebur128=peak=true:framelog=verbose[meter]",
        "-map",
        "[meter]",
        "-f",
        "null",
        "-",
    ]
