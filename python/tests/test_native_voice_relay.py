from __future__ import annotations

from pathlib import Path

from backend.infrastructure.native_voice_relay import NativeVoiceRelayProcess


class _Input:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def write(self, value: str) -> int:
        self.lines.append(value)
        return len(value)

    def flush(self) -> None:
        pass


class _ClosedInput(_Input):
    def write(self, value: str) -> int:
        raise BrokenPipeError("relay already exited")


class _Output:
    def __init__(self) -> None:
        self.responses = iter(["READY\t40000\n", "REALTIME\n"])

    def readline(self) -> str:
        return next(self.responses, "OK\n")


class _Process:
    def __init__(self) -> None:
        self.stdin = _Input()
        self.stdout = _Output()
        self.returncode: int | None = None

    def wait(self, timeout: float) -> int:
        assert timeout == 5
        self.returncode = 0
        return 0

    def kill(self) -> None:
        self.returncode = -1


def test_native_relay_process_replays_queued_control_before_serving_audio() -> None:
    process = _Process()
    launches: list[list[str]] = []

    def launch(arguments: list[str], **_options: object) -> _Process:
        launches.append(arguments)
        return process

    relay = NativeVoiceRelayProcess(Path("NativeVoiceRelay"), 40_000, popen=launch)
    relay.command("EXPECT\troom\talice\t123")
    relay.command("DEADLINE\troom\t80")
    relay.start()
    relay.command("PING")
    relay.stop()

    assert launches == [["NativeVoiceRelay", "--port", "40000"]]
    assert process.stdin.lines == [
        "SCHEDULING\n",
        "EXPECT\troom\talice\t123\n",
        "DEADLINE\troom\t80\n",
        "PING\n",
        "STOP\n",
    ]


def test_native_relay_process_reads_recipient_metrics_from_the_data_plane() -> None:
    process = _Process()
    responses = iter([
        "READY\t40000\n",
        "REALTIME\n",
        '{"packets":42,"latest_gap_ms":2.5,"maximum_gap_ms":7.5,"stalls":1,'
        '"pipeline_generation":3,"pipeline_position":48000}\n',
    ])
    process.stdout.readline = lambda: next(responses)
    relay = NativeVoiceRelayProcess(Path("NativeVoiceRelay"), 40_000, popen=lambda *_a, **_k: process)
    relay.start()

    assert relay.recipient_metrics("room", "alice") == {
        "packets": 42,
        "latest_gap_ms": 2.5,
        "maximum_gap_ms": 7.5,
        "stalls": 1,
        "pipeline_generation": 3,
        "pipeline_position": 48000,
    }


def test_native_relay_process_reads_participant_levels_from_the_data_plane() -> None:
    process = _Process()
    responses = iter(["READY\t40000\n", "REALTIME\n", '{"alice":0.25,"bob":0.5}\n'])
    process.stdout.readline = lambda: next(responses)
    relay = NativeVoiceRelayProcess(Path("NativeVoiceRelay"), 40_000, popen=lambda *_a, **_k: process)
    relay.start()

    assert relay.participant_levels("room") == {"alice": 0.25, "bob": 0.5}


def test_native_relay_refuses_to_run_the_voice_loop_at_normal_priority() -> None:
    process = _Process()
    process.stdout.responses = iter(["READY\t40000\n", "NORMAL\n"])
    relay = NativeVoiceRelayProcess(Path("NativeVoiceRelay"), 40_000, popen=lambda *_a, **_k: process)

    try:
        relay.start()
    except RuntimeError as error:
        assert "real-time scheduling" in str(error)
    else:
        raise AssertionError("normal-priority native relay was accepted")
    assert process.returncode == -1


def test_native_relay_stop_tolerates_an_already_closed_control_pipe() -> None:
    process = _Process()
    relay = NativeVoiceRelayProcess(Path("NativeVoiceRelay"), 40_000, popen=lambda *_a, **_k: process)
    relay.start()
    process.stdin = _ClosedInput()

    relay.stop()

    assert process.returncode == 0
