"""The voice protocol and room timing policy have one definition; C++ and Python cannot drift."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from scripts.audio_contract_codegen import HEADER, render
from backend.room.voice_protocol import (
    VOICE_PACKET_FRAMES,
    VOICE_PACKET_MS,
    VOICE_PACKET_SECONDS,
    VOICE_SAMPLE_RATE_HZ,
)

ROOT = Path(__file__).resolve().parents[2]

# Code that speaks the voice protocol or applies the room timing policy.
PROTOCOL_CODE = (
    "python/backend/infrastructure/voice_relay.py",
    "python/backend/room/domain.py",
    "python/backend/room/commands.py",
    "python/backend/room/timing.py",
    "AudioService/src/relay/NativeVoiceRelay.cpp",
    "AudioService/src/relay/NativeVoiceRelayMain.cpp",
    "AudioService/src/network/NetworkPacket.hpp",
    "AudioService/src/network/NetworkAudioEngine.cpp",
    "AudioService/src/network/NetworkTestRunner.cpp",
)
INDEPENDENT_DEFINITIONS = (
    re.compile(r"\b48[_']?000\b"),  # the transport rate
    re.compile(r"RETURN_ROUTE_RESERVE|ReturnRouteReserve"),  # the old fixed 10 ms reserve
    re.compile(r"timedelta\(seconds=3\)"),  # the coordinated start lead
)


def _code_without_comments(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    marker = "#" if path.suffix == ".py" else "//"
    return "\n".join(line.split(marker, 1)[0] for line in text.splitlines())


def test_the_generated_cpp_contract_matches_its_python_definition() -> None:
    assert HEADER.read_text(encoding="utf-8") == render(), (
        "Run `python -m scripts.audio_contract_codegen` from the python folder"
    )


def test_packet_duration_follows_the_packet_length() -> None:
    assert VOICE_PACKET_SECONDS == VOICE_PACKET_FRAMES / VOICE_SAMPLE_RATE_HZ
    assert VOICE_PACKET_MS == pytest.approx(2.5)


@pytest.mark.parametrize("relative", PROTOCOL_CODE)
def test_protocol_code_has_no_independent_definition_of_the_contract(relative: str) -> None:
    code = _code_without_comments(ROOT / relative)

    for pattern in INDEPENDENT_DEFINITIONS:
        assert not pattern.search(code), f"{relative} redefines {pattern.pattern}"
