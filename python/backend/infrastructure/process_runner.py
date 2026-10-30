from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import threading
import time
from queue import Empty, Full, Queue
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Callable, Iterable, Mapping, Protocol, Sequence

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.windows_child_job import WindowsChildJob

# Provider JSON and diagnostics are control data, not streaming PCM. Bound their combined retention.
MAX_PROCESS_OUTPUT_BYTES = 256 * 1024 * 1024
ProcessInput = bytes | Callable[[threading.Event], Iterable[bytes]]


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
        input_data: ProcessInput | None = None,
        cpu_fraction: float | None = None,
    ) -> ProcessResult:
        if cancel and cancel.is_set():
            raise DomainError("ProcessCancelled", "External process was cancelled", 499)
        if cpu_fraction is not None and sys.platform != "win32":
            raise DependencyError(
                "ProcessCpuLimitUnavailable", "Process CPU limits are unavailable"
            )
        process = None
        job = None
        pipes = None
        try:
            job = WindowsChildJob(cpu_fraction=cpu_fraction) if sys.platform == "win32" else None
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
                self._cleanup_process(process, pipes)

    @staticmethod
    def _cleanup_process(process: subprocess.Popen[bytes], pipes: _ProcessIo | None) -> None:
        ProcessRunner._terminate_tree(process)
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
            pipes.stop_input()
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

    def __init__(
        self, process: subprocess.Popen[bytes], limit: int, data: ProcessInput | None
    ) -> None:
        self._process = process
        self._limit = limit
        self._data = data
        self._input_stop = threading.Event()
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
                    raise DependencyError(
                        "ProcessOutputLimit", "External process output exceeds the memory limit"
                    )
                self._bytes += len(chunk)
                output.extend(chunk)

    def _write(self, stream: IO[bytes]) -> None:
        try:
            chunks = self._data(self._input_stop) if callable(self._data) else (self._data or b"",)
            for chunk in chunks:
                data = memoryview(chunk)
                offset = 0
                while offset < len(data):
                    written = os.write(stream.fileno(), data[offset : offset + 65536])
                    if written <= 0:
                        raise OSError("External process input pipe made no progress")
                    offset += written
        except BrokenPipeError:
            pass  # The child may intentionally exit without consuming all input.
        finally:
            stream.close()

    def stop_input(self) -> None:
        self._input_stop.set()

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
        self.stop_input()
        for thread in self._threads:
            if thread.ident is not None:
                thread.join()


class LineChannel(Protocol):
    """A long-lived child process that is controlled by one text line per request."""

    def write_line(self, line: str) -> None: ...

    def read_line(self) -> str: ...

    def stop(self, timeout_seconds: float) -> None: ...

    def kill(self) -> None: ...


class LineProcess:
    """A child that lives as long as its owner, controlled over stdin/stdout lines.

    A reader forwards stderr to the server logger without blocking the control protocol on stdout.
    """

    def __init__(self, process: subprocess.Popen[str]) -> None:
        if process.stdin is None or process.stdout is None or process.stderr is None:
            process.kill()
            raise DependencyError(
                "ProcessUnavailable", "External process control pipes are missing"
            )
        self._process = process
        self._stdin = process.stdin
        self._stdout = process.stdout
        self._stderr = process.stderr
        self._stderr_thread = threading.Thread(target=self._forward_stderr, daemon=True)
        self._stderr_thread.start()
        self._commands: Queue[str] = Queue(maxsize=1)
        self._stdin_thread = threading.Thread(target=self._write_stdin, daemon=True)
        self._stdin_thread.start()
        self._replies: Queue[str | None] = Queue(maxsize=16)
        self._stdout_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._stdout_thread.start()

    def _write_stdin(self) -> None:
        while self._process.poll() is None:
            try:
                line = self._commands.get(timeout=0.5)
            except Empty:
                continue
            try:
                self._stdin.write(f"{line}\n")
                self._stdin.flush()
            except (OSError, ValueError):
                self.kill()
                return

    def _read_stdout(self) -> None:
        try:
            while line := self._stdout.readline(1024 * 1024):
                if not line.endswith("\n"):
                    self.kill()
                    break
                self._replies.put_nowait(line.rstrip("\r\n"))
        except (OSError, ValueError, Full):
            self.kill()
        finally:
            with suppress(Full):
                self._replies.put_nowait(None)

    def _forward_stderr(self) -> None:
        logger = logging.getLogger("native_voice_relay")
        while line := self._stderr.readline(4096):
            logger.error("%s", line.rstrip("\r\n"))

    @classmethod
    def start(cls, command: Sequence[str]) -> LineProcess:
        try:
            process = subprocess.Popen(
                list(command),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                bufsize=1,
            )
        except OSError as exc:
            raise DependencyError("ProcessUnavailable", "External process could not start") from exc
        return cls(process)

    def write_line(self, line: str) -> None:
        if self._process.poll() is not None:
            raise OSError("Native voice relay has exited")
        try:
            self._commands.put(line, timeout=5.0)
        except Full as error:
            self.kill()
            raise OSError("Native voice relay command timed out") from error

    def read_line(self) -> str:
        try:
            reply = self._replies.get(timeout=5.0)
        except Empty as error:
            self.kill()
            raise RuntimeError("Native voice relay response timed out") from error
        if reply is None:
            raise RuntimeError("Native voice relay closed its control pipe")
        return reply

    def stop(self, timeout_seconds: float) -> None:
        """Waits for a child that was asked to exit, and kills it if it does not."""
        try:
            self._process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait(timeout=timeout_seconds)
        self._stderr_thread.join(timeout=timeout_seconds)
        self._stdout_thread.join(timeout=timeout_seconds)
        self._stdin_thread.join(timeout=timeout_seconds)
        for stream in (self._stdin, self._stdout, self._stderr):
            stream.close()

    def kill(self) -> None:
        self._process.kill()
