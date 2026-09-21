from __future__ import annotations

import threading
from pathlib import Path

import pytest

from backend.ai.domain import AiCapability, AiProviderDescriptor
from backend.domain_errors import DependencyError
from backend.infrastructure.command_ai_provider import CommandAiProvider
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.songs.domain import Language


class _ScriptedRunner(ProcessRunner):
    def __init__(self, stdout: bytes, exit_code: int = 0) -> None:
        self._result = ProcessResult(exit_code, stdout, b"")

    def run(self, command, **_):
        return self._result


def _provider(stdout: bytes, exit_code: int = 0) -> CommandAiProvider:
    descriptor = AiProviderDescriptor(
        provider_id="scripted",
        version="1",
        capabilities=frozenset(AiCapability),
        supported_languages=frozenset({"Auto"}),
        required_models=(),
        required_resources={},
    )
    return CommandAiProvider(
        descriptor, ["worker"], _ScriptedRunner(stdout, exit_code), cpu_threads=1
    )


def test_transcript_may_be_empty_for_a_vocal_without_speech() -> None:
    provider = _provider(b'{"text": ""}')
    assert provider.transcribe(Path("vocal.wav"), Language.AUTO, threading.Event()) == ""


def test_transcript_must_be_a_string() -> None:
    provider = _provider(b'{"text": 5}')
    with pytest.raises(DependencyError) as error:
        provider.transcribe(Path("vocal.wav"), Language.AUTO, threading.Event())
    assert error.value.code == "AiProviderInvalidOutput"


def test_failed_worker_is_reported_as_provider_failure() -> None:
    provider = _provider(b"", exit_code=1)
    with pytest.raises(DependencyError) as error:
        provider.transcribe(Path("vocal.wav"), Language.AUTO, threading.Event())
    assert error.value.code == "AiProviderFailed"


def test_alignment_word_without_duration_is_an_invalid_output() -> None:
    provider = _provider(
        b'{"words": [{"text": "la", "start": 1.0, "end": 1.0, "confidence": 0.9}]}'
    )
    with pytest.raises(DependencyError) as error:
        provider.align(Path("vocal.wav"), "la", Language.AUTO, threading.Event())
    assert error.value.code == "AiProviderInvalidOutput"


def test_alignment_words_are_read_in_order() -> None:
    provider = _provider(
        b'{"words": [{"text": "la", "start": 1.0, "end": 1.5, "confidence": 0.9},'
        b' {"text": "li", "start": 1.5, "end": 2.0, "confidence": 0.8}]}'
    )
    words = provider.align(Path("vocal.wav"), "la li", Language.AUTO, threading.Event())
    assert [word.text for word in words] == ["la", "li"]
