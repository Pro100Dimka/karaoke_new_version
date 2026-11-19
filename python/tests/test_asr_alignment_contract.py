from __future__ import annotations

import json
from pathlib import Path
from threading import Event

import pytest

from backend.ai.domain import WordTiming
from backend.infrastructure.process_runner import ProcessResult
from backend.serialization import dumps, loads_object
from backend.songs.domain import Language
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job
from tests.test_command_ai_provider import EXECUTION, _provider


def test_asr_alignment_returns_the_accepted_text_with_its_words():
    provider = _provider(
        b'{"lyrics":"we still sing","words":['
        b'{"text":"we","start":0,"end":1,"confidence":0.8},'
        b'{"text":"still","start":1,"end":2,"confidence":0.8},'
        b'{"text":"sing","start":2,"end":3,"confidence":0.8}]}',
        provider_id="local-torch",
    )
    result = provider.align_transcript(
        Path("voice.wav"), "we sing", Language.ENGLISH, Event(), execution=EXECUTION
    )
    assert result.lyrics == "we still sing"
    assert [word.text for word in result.words] == result.lyrics.split()
    assert "--asr-lyrics" in provider._runner.command


def test_custom_worker_keeps_the_existing_alignment_protocol():
    provider = _provider(b'{"words":[{"text":"sing","start":0,"end":1,"confidence":0.8}]}')
    result = provider.align_transcript(
        Path("voice.wav"), "sing", Language.ENGLISH, Event(), execution=EXECUTION
    )
    assert result.lyrics == "sing"
    assert [word.text for word in result.words] == ["sing"]
    assert "--asr-lyrics" not in provider._runner.command


def test_asr_views_keep_source_identity_and_crop_offset(tmp_path):
    provider = _provider(b"", provider_id="local-torch")
    vocal, original = tmp_path / "vocal.wav", tmp_path / "original.wav"
    vocal.write_bytes(b"separated audio")
    original.write_bytes(b"original audio")
    cancel = Event()
    evidence = {"text": "sing", "segments": [{"words": [{"word": "sing", "start": 1, "end": 2}]}]}
    for source, start in [(vocal, 0), (original, 0), (original, 10)]:
        provider._runner._result = ProcessResult(0, dumps(evidence).encode(), b"")
        provider.transcribe(
            source, Language.ENGLISH, cancel, execution=EXECUTION, start_seconds=start
        )
    provider._runner._result = ProcessResult(0, b'{"lyrics":"sing","words":[]}', b"")
    provider.align_transcript(vocal, "sing", Language.ENGLISH, cancel, execution=EXECUTION)
    payload = loads_object(provider._runner.options["input_data"].decode())
    original_full, original_tail = payload["alternatives"]
    assert payload["sourceId"] != original_full["sourceId"]
    assert original_full["sourceId"] == original_tail["sourceId"]
    assert [payload["cropStart"], original_full["cropStart"], original_tail["cropStart"]] == [
        0,
        0,
        10,
    ]
    assert original_tail["segments"] == evidence["segments"]


def test_worker_recovery_is_explicit_and_does_not_change_ordinary_alignment(monkeypatch):
    from backend.ai_worker import __main__ as cli

    calls = []
    monkeypatch.setattr(
        cli, "align", lambda *_args, **options: calls.append(options) or {"words": []}
    )
    arguments = ["align", "--input", "voice.wav", "--lyrics", "sing"]
    cli._run(cli._parser().parse_args(arguments))
    cli._run(cli._parser().parse_args([*arguments, "--asr-lyrics"]))
    assert not calls[0].get("asr_lyrics", False)
    assert calls[1]["asr_lyrics"] is True


def test_acoustic_retry_does_not_count_reconstructed_prefixes_as_independent_sources():
    from backend.ai_worker import speech

    def view(text, start, offset=0):
        return {
            "startSeconds": offset,
            "segments": [{"words": [{"word": text, "start": start, "end": start + 1}]}],
        }

    vocal, original, ending = view("sing", 1), view("sing", 1.1), view("sing", 1, 10)
    full = [[("sing", 1.0, 2.0)], [("sing", 1.1, 2.1)]]
    reconstructed = [*full, *full, *full]
    assert (
        speech._full_recognition_views({**vocal, "alternatives": [original, ending]}, reconstructed)
        == full
    )
    assert (
        speech._full_recognition_views({**vocal, "alternatives": [vocal, ending]}, reconstructed)
        == full[:1]
    )
    assert speech._full_recognition_views(None, full) == full


@pytest.mark.parametrize("with_catalogue", [False, True])
def test_published_asr_text_and_provenance_match_recovered_words(
    tmp_path, monkeypatch, with_catalogue
):
    from backend.ai.domain import AlignedTranscript

    source = tmp_path / "song.wav"
    write_wav(source, seconds=4)
    if with_catalogue:
        source.with_suffix(".txt").write_text("we sing", encoding="utf-8")
    provider = FakeAiProvider()
    monkeypatch.setattr(provider, "transcribe", lambda *_args, **_options: "we sing")
    monkeypatch.setattr(
        provider,
        "align",
        lambda _vocal, lyrics, *_args, **_options: tuple(
            WordTiming(text, index, index + 0.7, 0.8) for index, text in enumerate(lyrics.split())
        ),
    )
    calls = []

    def recover(_vocal, lyrics, _language, _cancel, **_options):
        calls.append(lyrics)
        return AlignedTranscript(
            "we still sing",
            tuple(
                WordTiming(text, index, index + 0.7, 0.8)
                for index, text in enumerate(["we", "still", "sing"])
            ),
        )

    monkeypatch.setattr(provider, "align_transcript", recover, raising=False)
    with app_client(tmp_path / "runtime", ai_providers=(provider,)) as client:
        song = import_song(client, source)
        response = client.post(
            f"/songs/{song['songId']}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        job = wait_for_job(client, response.json()["jobId"])
        assert job["state"] == "Succeeded", job
        document = client.get(f"/songs/{song['songId']}/editor").json()["document"]
        expected = ["we", "sing"] if with_catalogue else ["we", "still", "sing"]
        assert document["lyrics"].split() == expected
        assert [word["text"] for word in document["words"]] == expected
        manifest = (
            tmp_path / "runtime" / "songs" / song["songId"] / "revisions" / "2" / "manifest.json"
        )
        assert (
            json.loads(manifest.read_text("utf-8"))["provenance"]["lyricsSourceText"].split()
            == expected
        )
        assert calls == ([] if with_catalogue else ["we sing"])
