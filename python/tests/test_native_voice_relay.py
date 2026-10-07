from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pytest

from backend.infrastructure.native_voice_relay import NativeVoiceRelayProcess

_STARTED = ["READY\t40000", "REALTIME"]


class _Channel:
    """Stands in for the relay process: records control lines and answers them in order."""

    def __init__(self, responses: list[str] | None = None) -> None:
        self.lines: list[str] = []
        self.responses = iter(_STARTED if responses is None else responses)
        self.closed = False
        self.state: str | None = None

    def write_line(self, line: str) -> None:
        if self.closed:
            raise BrokenPipeError("relay already exited")
        self.lines.append(line)

    def read_line(self) -> str:
        return next(self.responses, "OK")

    def stop(self, timeout_seconds: float) -> None:
        assert timeout_seconds == 5
        self.state = "stopped"

    def kill(self) -> None:
        self.state = "killed"


def _relay(process: _Channel) -> NativeVoiceRelayProcess:
    return NativeVoiceRelayProcess(Path("NativeVoiceRelay"), 40_000, start_process=lambda _a: process)


def test_native_relay_process_replays_queued_control_before_serving_audio() -> None:
    process = _Channel()
    launches: list[list[str]] = []

    def launch(arguments: Sequence[str]) -> _Channel:
        launches.append(list(arguments))
        return process

    relay = NativeVoiceRelayProcess(Path("NativeVoiceRelay"), 40_000, start_process=launch)
    relay.command("EXPECT\troom\talice\t123")
    relay.command("DEADLINE\troom\t80")
    relay.start()
    relay.command("PING")
    relay.stop()

    assert launches == [["NativeVoiceRelay", "--port", "40000"]]
    assert process.lines == [
        "SCHEDULING",
        "EXPECT\troom\talice\t123",
        "DEADLINE\troom\t80",
        "PING",
        "STOP",
    ]
    assert process.state == "stopped"


def test_native_relay_process_reads_recipient_metrics_from_the_data_plane() -> None:
    process = _Channel([
        *_STARTED,
        '{"packets":42,"latest_gap_ms":2.5,"maximum_gap_ms":7.5,"stalls":1,'
        '"pipeline_generation":3,"pipeline_position":48000}',
    ])
    relay = _relay(process)
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
    process = _Channel([*_STARTED, '{"alice":0.25,"bob":0.5}'])
    relay = _relay(process)
    relay.start()

    assert relay.participant_levels("room") == {"alice": 0.25, "bob": 0.5}


@pytest.mark.parametrize("response", ["not json", "[1, 2]", '{"alice":"loud"}'])
def test_native_relay_rejects_malformed_data_plane_answers(response: str) -> None:
    relay = _relay(_Channel([*_STARTED, response]))
    relay.start()

    with pytest.raises(RuntimeError):
        relay.participant_levels("room")


def test_native_relay_refuses_to_run_the_voice_loop_at_normal_priority() -> None:
    process = _Channel(["READY\t40000", "NORMAL"])
    relay = _relay(process)

    with pytest.raises(RuntimeError, match="real-time scheduling"):
        relay.start()
    assert process.state == "killed"


def test_native_relay_stop_tolerates_an_already_closed_control_pipe() -> None:
    process = _Channel()
    relay = _relay(process)
    relay.start()
    process.closed = True

    relay.stop()

    assert process.state == "stopped"
