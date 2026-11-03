from __future__ import annotations

import sys
import threading
import time
from collections.abc import Iterator, Mapping, Sequence
from queue import Empty, Queue

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.process_runner import (
    MAX_PROCESS_OUTPUT_BYTES,
    ProcessHandle,
    ProcessResult,
    ProcessRunner,
    _ProcessIo,
)
from backend.infrastructure.windows_child_job import WindowsChildJob
from backend.serialization import dumps, loads_object


class SpeechSession:
    """Reuse imports within one song; keep cancellation and process-tree ownership."""

    def __init__(self, command: Sequence[str]) -> None:
        self._command = [*command, "serve-speech"]
        self._process: ProcessHandle | None = None
        self._job: WindowsChildJob | None = None
        self._pipes: _ProcessIo | None = None
        self._requests: Queue[bytes] = Queue(maxsize=1)
        self._lock = threading.Lock()
        self._offset = 0

    def _input(self, stopped: threading.Event) -> Iterator[bytes]:
        while not stopped.is_set():
            try:
                yield self._requests.get(timeout=0.1)
            except Empty:
                continue

    @staticmethod
    def _check(cancel: threading.Event, deadline: float) -> None:
        if cancel.is_set():
            raise DomainError("ProcessCancelled", "External process was cancelled", 499)
        if time.monotonic() >= deadline:
            raise DependencyError("ProcessTimeout", "External process timed out")

    def run(
        self,
        arguments: Sequence[str],
        *,
        environment: Mapping[str, str],
        input_data: bytes | None,
        timeout_seconds: float,
        cancel: threading.Event,
    ) -> ProcessResult:
        deadline = time.monotonic() + timeout_seconds
        while not self._lock.acquire(timeout=0.1):
            self._check(cancel, deadline)
        succeeded = False
        try:
            self._check(cancel, deadline)
            self._start(environment)
            request = (
                dumps(
                    {
                        "arguments": list(arguments),
                        "environment": dict(environment),
                        "input": (input_data or b"").decode("utf-8"),
                    }
                ).encode("utf-8")
                + b"\n"
            )
            self._requests.put_nowait(request)
            result = self._receive(cancel, deadline)
            succeeded = True
            return result
        finally:
            if not succeeded:
                self.close()
            self._lock.release()

    def _start(self, environment: Mapping[str, str]) -> None:
        if self._process is None:
            self._job = WindowsChildJob() if sys.platform == "win32" else None
            self._process = ProcessRunner._start(
                self._command, None, environment, self._job is not None
            )
            if self._job:
                self._job.attach_and_resume(self._process.pid)
            self._pipes = _ProcessIo(self._process, MAX_PROCESS_OUTPUT_BYTES, self._input)
            self._pipes.start()
        assert self._pipes is not None

    def _receive(self, cancel: threading.Event, deadline: float) -> ProcessResult:
        assert self._pipes is not None and self._process is not None
        while True:
            self._check(cancel, deadline)
            stdout, stderr = self._pipes.output()
            end = stdout.find(b"\n", self._offset)
            if end >= 0:
                reply = loads_object(stdout[self._offset : end].decode("utf-8"))
                self._offset = end + 1
                code, output, diagnostic = (
                    reply.get("code"),
                    reply.get("stdout"),
                    reply.get("stderr"),
                )
                if (
                    not isinstance(code, int)
                    or not isinstance(output, str)
                    or not isinstance(diagnostic, str)
                ):
                    raise DependencyError(
                        "AiProviderInvalidOutput", "Speech worker response is malformed"
                    )
                result = ProcessResult(
                    code, output.encode("utf-8"), stderr + diagnostic.encode("utf-8")
                )
                if code:
                    self.close()
                return result
            if self._process.poll() is not None:
                raise DependencyError("AiProviderFailed", "Speech worker exited before replying")
            cancel.wait(0.05)

    def close(self) -> None:
        if self._job:
            self._job.close()
            self._job = None
        if self._process is not None:
            ProcessRunner._cleanup_process(self._process, self._pipes)
        self._process = self._pipes = None
        self._offset = 0
        self._requests = Queue(maxsize=1)
