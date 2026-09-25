import sys
import time
import threading

import pytest

from backend.domain_errors import DependencyError
from backend.infrastructure import process_runner
from backend.infrastructure.process_runner import ProcessRunner


@pytest.fixture(autouse=True)
def no_pipe_worker_leaks():
    yield
    assert not [thread for thread in threading.enumerate() if thread.name.startswith("process-")]


@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_process_output_is_bounded_before_returning_a_result(monkeypatch, stream):
    monkeypatch.setattr(process_runner, "MAX_PROCESS_OUTPUT_BYTES", 4096, raising=False)
    script = f"import sys; sys.{stream}.buffer.write(b'x' * 8192)"
    with pytest.raises(DependencyError, match="output.*limit"):
        ProcessRunner().run([sys.executable, "-c", script], timeout_seconds=3)


def test_timeout_applies_while_a_child_does_not_read_stdin():
    started = time.monotonic()
    with pytest.raises(DependencyError, match="timed out"):
        ProcessRunner().run(
            [sys.executable, "-c", "import threading; threading.Event().wait(2)"],
            timeout_seconds=0.1, input_data=b"x" * (1 << 20),
        )
    assert time.monotonic() - started < 1, "a blocked stdin write must not defeat the deadline"


def test_complete_output_and_input_survive_chunked_pipe_io():
    data = b"abcdefgh" * 20000
    script = (
        "import sys; data=sys.stdin.buffer.read(); "
        "sys.stdout.buffer.write(data[::-1]); sys.stderr.buffer.write(data)"
    )
    result = ProcessRunner().run([sys.executable, "-c", script], timeout_seconds=3, input_data=data)
    assert result.exit_code == 0 and result.stdout == data[::-1] and result.stderr == data


def test_partial_pipe_worker_startup_reaps_started_workers(monkeypatch):
    original = threading.Thread.start
    started = 0

    def start(thread):
        nonlocal started
        if thread.name.startswith("process-"):
            started += 1
            if started == 2:
                raise RuntimeError("thread startup failed")
        original(thread)

    monkeypatch.setattr(threading.Thread, "start", start)
    with pytest.raises(RuntimeError, match="thread startup failed"):
        ProcessRunner().run(
            [sys.executable, "-c", "import threading; threading.Event().wait(30)"], timeout_seconds=1,
        )
