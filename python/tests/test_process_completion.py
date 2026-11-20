"""Wake completed work from pipe events while preserving process ownership."""

from types import SimpleNamespace
from pathlib import Path
import os
import signal
import subprocess
import sys
import threading

import pytest

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure import process_runner
from backend.infrastructure.process_runner import ProcessRunner


@pytest.fixture(autouse=True)
def no_pipe_worker_leaks():
    yield
    assert not [thread for thread in threading.enumerate() if thread.name.startswith("process-")]


def _pipes(wait):
    stopped = threading.Event()
    return SimpleNamespace(
        finished=SimpleNamespace(wait=wait),
        stop_input=stopped.set,
        stopped=stopped,
        raise_if_failed=lambda: None,
        output=lambda: (b"complete stdout", b"complete stderr"),
    )


def test_pipe_eof_wakes_completed_process_without_timed_polling():
    process = SimpleNamespace(returncode=None)
    process.poll = lambda: process.returncode
    process.wait = lambda **kwargs: pytest.fail("Wait for pipe EOF before timed process polling")

    def completed(timeout):
        assert 0 < timeout <= 0.1
        process.returncode = 7
        return True

    result = ProcessRunner()._communicate(process, 1, None, _pipes(completed))
    assert (result.exit_code, result.stdout, result.stderr) == (
        7,
        b"complete stdout",
        b"complete stderr",
    )


def test_closed_stdio_still_waits_for_a_live_child_without_busy_spinning():
    process, observed = SimpleNamespace(returncode=None), []
    process.poll = lambda: process.returncode

    def closed(timeout):
        observed.append("eof")
        return True

    def wait(timeout):
        assert observed and observed[-1] == "eof"
        assert 0 < timeout <= 0.1
        observed.append("wait")
        if observed.count("wait") == 1:
            raise subprocess.TimeoutExpired("child", timeout)
        process.returncode = 3
        return 3

    process.wait = wait
    result = ProcessRunner()._communicate(process, 1, None, _pipes(closed))
    assert result.exit_code == 3 and observed == ["eof", "wait", "eof", "wait"]


def test_pipe_wait_cannot_add_a_second_timeout_budget(monkeypatch):
    now = [0.0]
    monkeypatch.setattr(process_runner.time, "monotonic", lambda: now[0])
    process = SimpleNamespace(returncode=None, poll=lambda: None)
    process.wait = lambda **kwargs: pytest.fail("The deadline expired while waiting for pipe EOF")

    def completed(timeout):
        now[0] += timeout
        return True

    with pytest.raises(TimeoutError):
        ProcessRunner()._communicate(process, 0.05, None, _pipes(completed))


def test_exited_child_stops_deferred_input_before_waiting_for_pipe_completion():
    process = SimpleNamespace(returncode=0, poll=lambda: 0, wait=lambda **kwargs: 0)
    pipes = _pipes(lambda timeout: True)

    def completed(timeout):
        assert pipes.stopped.is_set(), "Release the input producer before waiting for it"
        return True

    pipes.finished.wait = completed
    result = ProcessRunner()._communicate(process, 1, None, pipes)
    assert result.exit_code == 0


def test_cancellation_observed_at_pipe_eof_cannot_return_success():
    cancel = threading.Event()
    process = SimpleNamespace(returncode=0, poll=lambda: 0, wait=lambda **kwargs: 0)

    def completed(timeout):
        cancel.set()
        return True

    with pytest.raises(DomainError, match="cancelled"):
        ProcessRunner()._communicate(process, 1, cancel, _pipes(completed))


def test_real_child_with_early_closed_stdio_returns_its_eventual_exit_code():
    script = (
        "import os,threading; os.close(1); os.close(2); threading.Event().wait(.03); os._exit(7)"
    )
    result = ProcessRunner().run([sys.executable, "-c", script], timeout_seconds=3)
    assert result.exit_code == 7 and result.stdout == result.stderr == b""


def test_cancellation_still_terminates_a_child_after_stdio_closed():
    cancel = threading.Event()
    timer = threading.Timer(0.1, cancel.set)
    timer.start()
    try:
        with pytest.raises(DomainError, match="cancelled"):
            ProcessRunner().run(
                [
                    sys.executable,
                    "-c",
                    "import os,threading; os.close(1); os.close(2); threading.Event().wait(10)",
                ],
                timeout_seconds=3,
                cancel=cancel,
            )
    finally:
        timer.cancel()
        timer.join()


def _linux_process_running(pid):
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[0]
    except FileNotFoundError:
        return False
    return state not in {"Z", "X"}


@pytest.mark.skipif(sys.platform != "linux", reason="Linux process-group ownership and /proc state")
@pytest.mark.parametrize("parent_exits", [False, True])
def test_timeout_closes_descendant_pipes_even_if_the_parent_exited(tmp_path, parent_exits):
    marker = tmp_path / "child.pid"
    child = (
        "import os,signal,threading; from pathlib import Path; "
        "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        f"Path({str(marker)!r}).write_text(str(os.getpid())); threading.Event().wait(10)"
    )
    parent = (
        "import os,subprocess,threading; "
        f"subprocess.Popen([{sys.executable!r},'-c',{child!r}]); "
        + ("os._exit(0)" if parent_exits else "threading.Event().wait(10)")
    )
    try:
        with pytest.raises(DependencyError, match="timed out"):
            ProcessRunner().run([sys.executable, "-c", parent], timeout_seconds=0.4)
        assert marker.exists(), "The descendant must start before testing owned cleanup"
        assert not _linux_process_running(int(marker.read_text()))
    finally:
        if marker.exists():
            pid = int(marker.read_text())
            if _linux_process_running(pid):
                os.kill(pid, signal.SIGKILL)
