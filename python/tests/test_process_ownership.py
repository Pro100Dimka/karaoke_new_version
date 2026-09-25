import os
import signal
import subprocess
import sys
import threading
import ctypes
from ctypes import wintypes

import pytest

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.instance_lock import _process_exists
from backend.infrastructure.process_runner import ProcessRunner


def _wait_for_windows_exit(pid):
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    api.OpenProcess.restype = wintypes.HANDLE
    api.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    api.WaitForSingleObject.restype = wintypes.DWORD
    api.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = api.OpenProcess(0x00100000, False, pid)
    if not handle:
        return not _process_exists(pid)
    try:
        return api.WaitForSingleObject(handle, 2000) == 0
    finally:
        api.CloseHandle(handle)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows process-tree lifetime")
@pytest.mark.parametrize("parent_exits", [False, True])
def test_timeout_reaps_descendants_even_if_parent_exited(tmp_path, parent_exits):
    marker = tmp_path / "child.pid"
    python = getattr(sys, "_base_executable", sys.executable)
    child_script = (
        "import signal,threading,os; from pathlib import Path; "
        "signal.signal(getattr(signal,'SIGBREAK',signal.SIGTERM), signal.SIG_IGN); "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        f"Path({str(marker)!r}).write_text(str(os.getpid())); threading.Event().wait(30)"
    )
    parent_script = (
        "import subprocess,threading,os; "
        f"subprocess.Popen([{python!r}, '-c', {child_script!r}]); "
        + ("os._exit(0)" if parent_exits else "threading.Event().wait(30)")
    )
    pid = None
    try:
        with pytest.raises(DependencyError, match="timed out"):
            ProcessRunner().run([python, "-c", parent_script], timeout_seconds=0.75)
        assert marker.exists(), "The controlled child must start before testing cleanup"
        pid = int(marker.read_text())
        assert _wait_for_windows_exit(pid), "Timed-out children must not retain CPU/GPU/files/pipes"
    finally:
        if marker.exists():
            pid = int(marker.read_text())
        if pid is not None and _process_exists(pid):
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=5
                )
            else:
                os.kill(pid, signal.SIGKILL)


def test_cancelled_work_never_starts_a_process(monkeypatch):
    started = []
    monkeypatch.setattr(ProcessRunner, "_start", lambda *args: started.append(args))
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError, match="cancelled"):
        ProcessRunner().run(["unused"], timeout_seconds=1, cancel=cancel)
    assert not started


def test_communication_failure_terminates_and_closes_the_owned_process(monkeypatch):
    runner = ProcessRunner()
    original_start = runner._start
    started = []

    def track_start(*args):
        process = original_start(*args)
        started.append(process)
        return process

    def broken_pipe(*args):
        raise OSError("pipe failure")

    monkeypatch.setattr(runner, "_start", track_start)
    monkeypatch.setattr(runner, "_communicate", broken_pipe)
    try:
        with pytest.raises(DependencyError):
            runner.run(
                [sys.executable, "-c", "import threading; threading.Event().wait(30)"],
                timeout_seconds=1,
            )
        process = started[0]
        assert process.poll() is not None
        assert all(stream.closed for stream in (process.stdin, process.stdout, process.stderr))
    finally:
        for process in started:
            if process.poll() is None:
                if sys.platform == "win32":
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        capture_output=True,
                        timeout=5,
                    )
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=5)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows process containment")
def test_failed_job_assignment_never_executes_child_code(tmp_path, monkeypatch):
    from backend.infrastructure.windows_child_job import WindowsChildJob

    marker = tmp_path / "should-not-exist"
    started = []
    runner = ProcessRunner()
    original_start = runner._start

    def track_start(*args):
        process = original_start(*args)
        started.append(process)
        return process

    def deny_assignment(*args):
        raise OSError("job assignment denied")

    monkeypatch.setattr(runner, "_start", track_start)
    monkeypatch.setattr(WindowsChildJob, "attach_and_resume", deny_assignment)
    with pytest.raises(DependencyError):
        runner.run(
            [sys.executable, "-c", f"from pathlib import Path; Path({str(marker)!r}).touch()"],
            timeout_seconds=2,
        )
    assert not marker.exists()
    assert len(started) == 1 and started[0].poll() is not None
