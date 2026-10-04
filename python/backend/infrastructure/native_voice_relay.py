from __future__ import annotations

import json
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any


class NativeVoiceRelayProcess:
    """Owns the native data plane while FastAPI remains the room control plane."""

    def __init__(
        self,
        executable: Path,
        port: int,
        *,
        popen: Callable[..., Any] = subprocess.Popen,
    ) -> None:
        self._executable = executable
        self._port = port
        self._popen = popen
        self._process: Any | None = None
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
            process = self._popen(
                [str(self._executable), "--port", str(self._port)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            if process.stdin is None or process.stdout is None:
                process.kill()
                raise RuntimeError("Native voice relay control pipes are unavailable")
            ready = process.stdout.readline().rstrip("\r\n")
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
            assert process.stdin is not None
            try:
                process.stdin.write("STOP\n")
                process.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def recipient_metrics(self, room_id: str, participant_id: str) -> dict[str, int | float]:
        with self._lock:
            response = self._request_locked(f"METRICS\t{room_id}\t{participant_id}")
        parsed = json.loads(response)
        if not isinstance(parsed, dict):
            raise RuntimeError("Native voice relay returned invalid recipient metrics")
        return parsed

    def participant_levels(self, room_id: str) -> dict[str, float]:
        with self._lock:
            response = self._request_locked(f"LEVELS\t{room_id}")
        parsed = json.loads(response)
        if not isinstance(parsed, dict):
            raise RuntimeError("Native voice relay returned invalid participant levels")
        return {str(participant): float(level) for participant, level in parsed.items()}

    def _send_locked(self, value: str) -> None:
        response = self._request_locked(value)
        if response != "OK":
            raise RuntimeError(f"Native voice relay rejected {value.split(chr(9), 1)[0]}: {response}")

    def _request_locked(self, value: str) -> str:
        assert self._process is not None
        assert self._process.stdin is not None
        assert self._process.stdout is not None
        self._process.stdin.write(f"{value}\n")
        self._process.stdin.flush()
        return self._process.stdout.readline().rstrip("\r\n")
