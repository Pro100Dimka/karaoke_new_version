from __future__ import annotations

import threading
from collections.abc import Callable, Sequence
from pathlib import Path

from backend.infrastructure.process_runner import LineChannel, LineProcess
from backend.serialization import loads_object

_STOP_TIMEOUT_SECONDS = 5.0


class NativeVoiceRelayProcess:
    """Owns the native data plane while FastAPI remains the room control plane."""

    def __init__(
        self,
        executable: Path,
        port: int,
        *,
        start_process: Callable[[Sequence[str]], LineChannel] = LineProcess.start,
    ) -> None:
        self._executable = executable
        self._port = port
        self._start_process = start_process
        self._process: LineChannel | None = None
        self._queued: list[str] = []
        self._lock = threading.Lock()

    def command(self, value: str) -> None:
        if "\n" in value or "\r" in value:
            raise ValueError("Native relay commands must fit on one line")
        with self._lock:
            if self._process is None:
                self._queued.append(value)
                return
            self._send_locked(value)

    def start(self) -> None:
        with self._lock:
            if self._process is not None:
                return
            process = self._start_process([str(self._executable), "--port", str(self._port)])
            ready = process.read_line()
            if ready != f"READY\t{self._port}":
                process.kill()
                raise RuntimeError(f"Native voice relay failed to start: {ready or 'no response'}")
            self._process = process
            if self._request_locked("SCHEDULING") != "REALTIME":
                self._process = None
                process.kill()
                raise RuntimeError("Native voice relay could not acquire real-time scheduling")
            queued, self._queued = self._queued, []
            for command in queued:
                self._send_locked(command)

    def stop(self) -> None:
        with self._lock:
            process, self._process = self._process, None
            if process is None:
                self._queued.clear()
                return
            try:
                process.write_line("STOP")
            except OSError:
                pass  # Already exited: there is nothing left to ask, only to reap.
        process.stop(_STOP_TIMEOUT_SECONDS)

    def recipient_metrics(self, room_id: str, participant_id: str) -> dict[str, int | float]:
        with self._lock:
            response = self._request_locked(f"METRICS\t{room_id}\t{participant_id}")
        return {str(key): _number(value) for key, value in _object(response, "recipient metrics").items()}

    def participant_levels(self, room_id: str) -> dict[str, float]:
        with self._lock:
            response = self._request_locked(f"LEVELS\t{room_id}")
        levels = _object(response, "participant levels")
        return {str(participant): float(_number(level)) for participant, level in levels.items()}

    def _send_locked(self, value: str) -> None:
        response = self._request_locked(value)
        if response != "OK":
            raise RuntimeError(f"Native voice relay rejected {value.split(chr(9), 1)[0]}: {response}")

    def _request_locked(self, value: str) -> str:
        assert self._process is not None
        self._process.write_line(value)
        return self._process.read_line()


def _object(response: str, what: str) -> dict[str, object]:
    try:
        return loads_object(response)
    except ValueError as error:
        raise RuntimeError(f"Native voice relay returned invalid {what}") from error


def _number(value: object) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError("Native voice relay returned a non-numeric value")
    return value
