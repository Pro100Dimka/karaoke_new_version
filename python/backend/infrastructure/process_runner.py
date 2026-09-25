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
from typing import Mapping, Sequence

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.windows_child_job import WindowsChildJob


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
        try:
            job = WindowsChildJob() if sys.platform == "win32" else None
            process = self._start(command, cwd, environment, job is not None)
            if job:
                job.attach_and_resume(process.pid)
            return self._communicate(process, timeout_seconds, cancel, input_data)
        except TimeoutError as exc:
            raise DependencyError("ProcessTimeout", "External process timed out") from exc
        except OSError as exc:
            raise DependencyError(
                "ProcessIoFailed", "External process communication failed"
            ) from exc
        finally:
            if job:
                job.close()
            if process is not None:
                self._terminate_tree(process)
                # communicate joins Windows pipe-reader threads after the owned tree is gone.
                with suppress(OSError):
                    process.communicate(timeout=2)
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
        input_data: bytes | None,
    ) -> ProcessResult:
        deadline = time.monotonic() + timeout_seconds
        pending_input = input_data
        while True:
            if cancel and cancel.is_set():
                raise DomainError("ProcessCancelled", "External process was cancelled", 499)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            try:
                stdout, stderr = process.communicate(
                    input=pending_input, timeout=min(0.1, remaining)
                )
                return ProcessResult(process.returncode, stdout, stderr)
            except subprocess.TimeoutExpired:
                pending_input = None

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
