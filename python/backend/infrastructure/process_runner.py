from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Callable, Mapping, Sequence

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.windows_child_job import WindowsChildJob

# Provider JSON and diagnostics are control data, not streaming PCM. Bound their combined retention.
MAX_PROCESS_OUTPUT_BYTES = 256 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class ProcessResult:
    exit_code: int
    stdout: bytes
    stderr: bytes


class ProcessRunner:
    def run(
        self,
        command: Sequence[str],
        *,
        timeout_seconds: float,
        cwd: Path | None = None,
        environment: Mapping[str, str] | None = None,
        cancel: threading.Event | None = None,
        input_data: bytes | None = None,
    ) -> ProcessResult:
        if cancel and cancel.is_set():
            raise DomainError("ProcessCancelled", "External process was cancelled", 499)
        process = None
        job = None
        pipes = None
        try:
            job = WindowsChildJob() if sys.platform == "win32" else None
            process = self._start(command, cwd, environment, job is not None)
            if job:
                job.attach_and_resume(process.pid)
            pipes = _ProcessIo(process, MAX_PROCESS_OUTPUT_BYTES, input_data)
            pipes.start()
            return self._communicate(process, timeout_seconds, cancel, pipes)
        except TimeoutError as exc:
            raise DependencyError("ProcessTimeout", "External process timed out") from exc
        except OSError as exc:
            raise DependencyError(
                "_ProcessIoFailed", "External process communication failed"
            ) from exc
        finally:
            if job:
                job.close()
            if process is not None:
                self._terminate_tree(process)
                if pipes is not None:
                    pipes.join()
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream:
                        with suppress(OSError):
                            stream.close()

    @staticmethod
    def _start(
        command: Sequence[str],
        cwd: Path | None,
        environment: Mapping[str, str] | None,
        suspended: bool = False,
    ) -> subprocess.Popen[bytes]:
        env = os.environ.copy()
        if environment:
            env.update(environment)
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        if suspended:
            creationflags |= 0x00000004  # CREATE_SUSPENDED, released only after job assignment.
        start_new_session = os.name != "nt"
        try:
            return subprocess.Popen(
                list(command),
                cwd=cwd,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=creationflags,
                start_new_session=start_new_session,
            )
        except OSError as exc:
            raise DependencyError("ProcessUnavailable", "External process could not start") from exc

    def _communicate(
        self,
        process: subprocess.Popen[bytes],
        timeout_seconds: float,
        cancel: threading.Event | None,
        pipes: _ProcessIo,
    ) -> ProcessResult:
        deadline = time.monotonic() + timeout_seconds
        while True:
            if cancel and cancel.is_set():
                raise DomainError("ProcessCancelled", "External process was cancelled", 499)
            pipes.raise_if_failed()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            try:
                process.wait(timeout=min(0.1, remaining))
            except subprocess.TimeoutExpired:
                continue
            if pipes.finished.wait(timeout=min(0.1, remaining)):
                stdout, stderr = pipes.output()
                return ProcessResult(process.returncode, stdout, stderr)

    @staticmethod
    def _terminate_tree(process: subprocess.Popen[bytes]) -> None:
        if sys.platform == "win32":
            # The job was closed first, including descendants of an already-exited launcher.
            if process.poll() is None:
                process.kill()
        else:
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            with suppress(subprocess.TimeoutExpired):
                process.wait(timeout=1)
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=2)


class _ProcessIo:
    """Owns bounded pipe readers and an optional writer until the process tree is reaped."""

    def __init__(self, process: subprocess.Popen[bytes], limit: int, data: bytes | None) -> None:
        self._process = process
        self._limit = limit
        self._data = data
        self._stdout = bytearray()
        self._stderr = bytearray()
        self._bytes = 0
        self._error: Exception | None = None
        self._mutex = threading.Lock()
        self._threads: list[threading.Thread] = []
        self._remaining = 0
        self.finished = threading.Event()

    def start(self) -> None:
        stdout, stderr, stdin = self._process.stdout, self._process.stderr, self._process.stdin
        assert stdout is not None and stderr is not None and stdin is not None
        operations = [
            ("stdout", lambda: self._read(stdout, self._stdout)),
            ("stderr", lambda: self._read(stderr, self._stderr)),
        ]
        if self._data:
            operations.append(("stdin", lambda: self._write(stdin)))
        else:
            stdin.close()
        self._remaining = len(operations)
        for name, operation in operations:
            thread = threading.Thread(target=self._work, args=(operation,), name=f"process-{name}")
            self._threads.append(thread)
            thread.start()

    def _work(self, operation: Callable[[], None]) -> None:
        try:
            operation()
        except Exception as exc:
            with self._mutex:
                if self._error is None:
                    self._error = exc
        finally:
            with self._mutex:
                self._remaining -= 1
                if self._remaining == 0:
                    self.finished.set()

    def _read(self, stream: IO[bytes], output: bytearray) -> None:
        while chunk := os.read(stream.fileno(), 65536):
            with self._mutex:
                if self._error is not None:
                    return
                if self._bytes + len(chunk) > self._limit:
                    raise DependencyError("ProcessOutputLimit", "External process output exceeds the memory limit")
                self._bytes += len(chunk)
                output.extend(chunk)

    def _write(self, stream: IO[bytes]) -> None:
        data = memoryview(self._data or b"")
        offset = 0
        try:
            while offset < len(data):
                written = os.write(stream.fileno(), data[offset:offset + 65536])
                if written <= 0:
                    raise OSError("External process input pipe made no progress")
                offset += written
        except BrokenPipeError:
            pass  # The child may intentionally exit without consuming all input.
        finally:
            stream.close()

    def raise_if_failed(self) -> None:
        with self._mutex:
            error = self._error
        if error is not None:
            raise error

    def output(self) -> tuple[bytes, bytes]:
        self.raise_if_failed()
        return bytes(self._stdout), bytes(self._stderr)

    def join(self) -> None:
        # The owner closes its job/process group before joining, so inherited pipe handles close too.
        for thread in self._threads:
            if thread.ident is not None:
                thread.join()
