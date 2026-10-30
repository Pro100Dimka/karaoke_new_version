from __future__ import annotations

import threading
import sys
import time
from pathlib import Path

import pytest

from backend.ai.domain import AiCapability, AiProviderDescriptor
from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.command_ai_provider import CommandAiProvider
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.songs.domain import Language
from backend.processing.compute_policy import ComputeDevice, ExecutionContext

EXECUTION = ExecutionContext(ComputeDevice.CPU, 1)


def test_worker_recognition_input_uses_utf8_even_with_a_windows_text_encoding(monkeypatch):
    import io
    from backend.ai_worker import __main__ as cli
    from backend.serialization import dumps

    evidence = {"segments": [{"words": [{"word": "Восьмим", "start": 1, "end": 2}]}]}
    stream = io.TextIOWrapper(io.BytesIO(dumps(evidence).encode("utf-8")), encoding="cp1251")
    monkeypatch.setattr(cli.sys, "stdin", stream)
    calls = []
    monkeypatch.setattr(cli, "align", lambda *_a, **options: calls.append(options) or {"words": []})
    args = cli._parser().parse_args(
        ["align", "--input", "vocal.wav", "--lyrics", "Восьмим", "--recognition-stdin"]
    )
    cli._run(args)
    assert calls[0]["recognition"] == evidence


class _ScriptedRunner(ProcessRunner):
    def __init__(self, stdout: bytes, exit_code: int = 0) -> None:
        self._result = ProcessResult(exit_code, stdout, b"")

    def run(self, command, **options):
        self.command = command
        self.options = options
        return self._result


def _provider(stdout: bytes, exit_code: int = 0, *, provider_id="scripted") -> CommandAiProvider:
    descriptor = AiProviderDescriptor(
        provider_id=provider_id,
        version="1",
        capabilities=frozenset(AiCapability),
        supported_languages=frozenset({"Auto"}),
        required_models=(),
        required_resources={},
    )
    return CommandAiProvider(descriptor, ["worker"], _ScriptedRunner(stdout, exit_code))


def test_local_transcription_group_retains_independent_views_for_alignment(tmp_path):
    from backend.serialization import dumps, loads_object

    vocal, source = tmp_path / "vocal.wav", tmp_path / "source.mp3"
    vocal.write_bytes(b"vocal")
    source.write_bytes(b"original")
    evidence = [{"text": text, "segments": []} for text in ["verse", "chorus", "ending"]]
    provider = _provider(dumps({"transcriptions": evidence}).encode(), provider_id="local-torch")
    cancel = threading.Event()
    result = provider.transcribe_many(
        [(vocal, 0.0), (source, 0.0), (vocal, 48.0)],
        Language.ENGLISH,
        cancel,
        execution=EXECUTION,
    )
    runner = provider._runner
    assert result == ("verse", "chorus", "ending")
    assert "transcribe-many" in runner.command
    assert runner.options["cancel"] is cancel
    assert runner.options["timeout_seconds"] == 3 * provider._timeout
    assert loads_object(runner.options["input_data"].decode()) == {
        "requests": [
            {"input": str(vocal), "startSeconds": 0.0},
            {"input": str(source), "startSeconds": 0.0},
            {"input": str(vocal), "startSeconds": 48.0},
        ]
    }
    runner._result = ProcessResult(0, b'{"words": []}', b"")
    provider.align(vocal, "verse chorus", Language.ENGLISH, cancel, execution=EXECUTION)
    assert loads_object(runner.options["input_data"].decode()) == {
        **evidence[0],
        "alternatives": [evidence[1]],
    }


@pytest.mark.parametrize("payload", [{}, {"transcriptions": []}, {"transcriptions": [None]}])
def test_invalid_transcription_group_is_rejected(payload):
    from backend.serialization import dumps

    provider = _provider(dumps(payload).encode(), provider_id="local-torch")
    with pytest.raises(DependencyError) as error:
        provider.transcribe_many(
            [(Path("vocal.wav"), 0.0)], Language.AUTO, threading.Event(), execution=EXECUTION
        )
    assert error.value.code == "AiProviderInvalidOutput"


def test_external_provider_keeps_its_existing_transcription_command():
    provider = _provider(b'{"text": "heard"}')
    assert provider.transcribe_many(
        [(Path("vocal.wav"), 0.0), (Path("vocal.wav"), 48.0)],
        Language.AUTO,
        threading.Event(),
        execution=EXECUTION,
    ) == ("heard", "heard")
    assert provider._runner.command == [
        "worker",
        "transcribe",
        "--input",
        "vocal.wav",
        "--language",
        "Auto",
        "--start-seconds",
        "48.0",
    ]


def test_empty_transcription_group_does_not_start_a_worker():
    provider = _provider(b"", provider_id="local-torch")
    assert provider.transcribe_many([], Language.AUTO, threading.Event(), execution=EXECUTION) == ()
    assert not hasattr(provider._runner, "command")


def test_cancelled_transcription_group_reports_job_cancellation(monkeypatch):
    provider = _provider(b"", provider_id="local-torch")

    def cancelled(*_args, **_kwargs):
        raise DomainError("ProcessCancelled", "Cancelled", 499)

    monkeypatch.setattr(provider._runner, "run", cancelled)
    with pytest.raises(DomainError) as error:
        provider.transcribe_many(
            [(Path("vocal.wav"), 0.0)], Language.AUTO, threading.Event(), execution=EXECUTION
        )
    assert error.value.code == "JobCancelled"


@pytest.mark.parametrize("change", [None, "vocal", "source", "language", "job", "device"])
@pytest.mark.parametrize("word_count", [1, 2000])
def test_local_alignment_reuses_only_unchanged_recognition_from_its_own_job(
    tmp_path, change, word_count
):
    from backend.serialization import dumps, loads_object

    provider = _provider(b"", provider_id="local-torch")
    runner = provider._runner
    cancel = threading.Event()
    vocal, source = tmp_path / "vocal.wav", tmp_path / "source.mp3"
    evidence = []
    for audio, word in [(vocal, "verse"), (source, "chorus")]:
        audio.write_bytes(word.encode())
        result = {
            "text": word,
            "segments": [{"words": [{"word": word, "start": 1, "end": 2}] * word_count}],
        }
        evidence.append(result)
        runner._result = ProcessResult(0, dumps(result).encode(), b"")
        provider.transcribe(audio, Language.ENGLISH, cancel, execution=EXECUTION)
    if change in {"vocal", "source"}:
        (vocal if change == "vocal" else source).write_bytes(b"changed audio")
    runner._result = ProcessResult(0, b'{"words": []}', b"")
    provider.align(
        vocal,
        "verse chorus",
        Language.RUSSIAN if change == "language" else Language.ENGLISH,
        threading.Event() if change == "job" else cancel,
        execution=ExecutionContext(ComputeDevice.CUDA, 1) if change == "device" else EXECUTION,
    )
    if change in {"vocal", "language", "job", "device"}:
        assert "--recognition-stdin" not in runner.command
        assert not runner.options.get("input_data")
    else:
        assert "--recognition-stdin" in runner.command
        assert loads_object(runner.options["input_data"].decode()) == evidence[0]
        if word_count == 2000 and change is None:
            assert len(runner.options["input_data"]) > 65536
            assert max(map(len, runner.command)) < 4096


def test_transcript_may_be_empty_for_a_vocal_without_speech() -> None:
    provider = _provider(b'{"text": ""}')
    assert (
        provider.transcribe(
            Path("vocal.wav"), Language.AUTO, threading.Event(), execution=EXECUTION
        )
        == ""
    )


def test_separation_preserves_isolated_rhythm(tmp_path):
    from backend.serialization import dumps

    for name in ["instrumental.wav", "vocals.wav"]:
        (tmp_path / name).write_bytes(b"stem")
    provider = _provider(
        dumps(
            {
                "instrumental": str(tmp_path / "instrumental.wav"),
                "referenceVocal": str(tmp_path / "vocals.wav"),
                "rhythm": [[0.5, 1], [1, 0.6]],
            }
        ).encode()
    )
    result = provider.separate(
        tmp_path / "source.wav", tmp_path, threading.Event(), execution=EXECUTION
    )
    assert result.rhythm == ((0.5, 1), (1, 0.6))


def test_transcript_must_be_a_string() -> None:
    provider = _provider(b'{"text": 5}')
    with pytest.raises(DependencyError) as error:
        provider.transcribe(
            Path("vocal.wav"), Language.AUTO, threading.Event(), execution=EXECUTION
        )
    assert error.value.code == "AiProviderInvalidOutput"


def test_failed_worker_is_reported_as_provider_failure() -> None:
    provider = _provider(b"", exit_code=1)
    with pytest.raises(DependencyError) as error:
        provider.transcribe(
            Path("vocal.wav"), Language.AUTO, threading.Event(), execution=EXECUTION
        )
    assert error.value.code == "AiProviderFailed"


def test_alignment_word_without_duration_is_an_invalid_output() -> None:
    provider = _provider(
        b'{"words": [{"text": "la", "start": 1.0, "end": 1.0, "confidence": 0.9}]}'
    )
    with pytest.raises(DependencyError) as error:
        provider.align(
            Path("vocal.wav"), "la", Language.AUTO, threading.Event(), execution=EXECUTION
        )
    assert error.value.code == "AiProviderInvalidOutput"


def test_alignment_words_are_read_in_order() -> None:
    provider = _provider(
        b'{"words": [{"text": "la", "start": 1.0, "end": 1.5, "confidence": 0.9},'
        b' {"text": "li", "start": 1.5, "end": 2.0, "confidence": 0.8}]}'
    )
    words = provider.align(
        Path("vocal.wav"), "la li", Language.AUTO, threading.Event(), execution=EXECUTION
    )
    assert [word.text for word in words] == ["la", "li"]


def test_alignment_supplies_synchronized_instrumental_to_the_worker() -> None:
    provider = _provider(b'{"words": []}')
    backing = Path("same-timeline-instrumental.wav")

    provider.align(
        Path("vocal.wav"),
        "la",
        Language.AUTO,
        threading.Event(),
        execution=EXECUTION,
        instrumental=backing,
    )

    arguments = provider._runner.command
    assert arguments[arguments.index("--instrumental") + 1] == str(backing)


def test_worker_cli_passes_the_optional_instrumental_context(monkeypatch) -> None:
    import backend.ai_worker.__main__ as worker

    received = {}
    monkeypatch.setattr(worker, "align", lambda *args, **kwargs: received.update(kwargs) or {})
    args = worker._parser().parse_args(
        [
            "align",
            "--input",
            "vocal.wav",
            "--lyrics",
            "la",
            "--instrumental",
            "same-timeline-instrumental.wav",
        ]
    )

    worker._run(args)

    assert received["instrumental"] == Path("same-timeline-instrumental.wav")


@pytest.mark.parametrize("diagnostics", [[], ["AsrCtcBoundaryDisagreement"]])
def test_alignment_preserves_optional_word_diagnostics(diagnostics) -> None:
    import json

    provider = _provider(
        json.dumps(
            {
                "words": [
                    {
                        "text": "la",
                        "start": 1.0,
                        "end": 1.5,
                        "confidence": 0.8,
                        "diagnostics": diagnostics,
                    }
                ]
            }
        ).encode()
    )

    word = provider.align(
        Path("vocal.wav"), "la", Language.AUTO, threading.Event(), execution=EXECUTION
    )[0]

    assert word.diagnostics == tuple(diagnostics)


@pytest.mark.parametrize("activity", [True, False, None])
def test_pitch_preserves_optional_audio_activity_independently_of_confidence(activity) -> None:
    field = b"" if activity is None else b', "audioActive": ' + str(activity).lower().encode()
    provider = _provider(
        b'{"points": [{"time": 0.1, "frequency": 440.0, "confidence": 0.1' + field + b"}]}"
    )
    point = provider.pitch(Path("vocal.wav"), threading.Event(), execution=EXECUTION)[0]
    assert point.audio_active is activity


@pytest.mark.parametrize("cancel_before_start", [True, False])
def test_actual_worker_cancellation_uses_the_job_cancelled_contract(tmp_path, cancel_before_start):
    marker = tmp_path / "started"
    command = [
        sys.executable,
        "-c",
        "import pathlib,sys,threading; pathlib.Path(sys.argv[1]).write_text('started'); "
        "threading.Event().wait(30)",
        str(marker),
    ]
    provider = CommandAiProvider(_provider(b"{}").descriptor, command, ProcessRunner())
    cancel = threading.Event()
    errors = []
    if cancel_before_start:
        cancel.set()

    def invoke():
        try:
            provider.pitch(tmp_path / "input.wav", cancel, execution=EXECUTION)
        except DomainError as error:
            errors.append(error.code)

    thread = threading.Thread(target=invoke)
    thread.start()
    try:
        if not cancel_before_start:
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                cancel.wait(0.02)
            assert marker.exists(), "Owned worker did not start"
    finally:
        cancel.set()
        thread.join(5)
    assert not thread.is_alive(), "Cancelled worker did not release its caller"
    assert errors == ["JobCancelled"]
    assert marker.exists() is not cancel_before_start
