from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest

from backend.ai.domain import AlignedTranscript, WordTiming
from backend.ai_worker import asr_recovery, speech
from backend.infrastructure.sidecar_lyrics import LocalSidecarLyricsReader
from backend.lyrics.discovery import LyricsDiscovery, LyricsMatchPolicy, PreparedLyrics
from backend.lyrics.ports import LyricLineTiming
from backend.processing.document_pipeline import BuildProcessingDocument
from backend.processing.preflight import ProcessingProviders
from backend.processing.stage_runner import StageRunner
from backend.songs.domain import Language
from tests.fakes import FakeAiProvider
from tests.test_asr_fresh_views import _raw
from tests.test_asr_recovery import _scores
from tests.test_command_ai_provider import EXECUTION, _provider
from tests.test_processing_normalized_source import _song


BASELINE = "stars guide us\nwe sing aloud"
EXPANDED = BASELINE + "\nwe sing aloud"
COMPLETE = "stars guide us birds fly softly we sing aloud we sing aloud"


def _views(*, added_repeat=True):
    primary = {
        **_raw(BASELINE, [(start, start + 0.4) for start in (1, 2, 3, 10, 11, 12)]),
        "sourceId": "vocal",
        "cropStart": 0.0,
        "cropEnd": 20.0,
    }
    text = COMPLETE if added_repeat else "stars guide us birds fly softly we sing aloud"
    starts = (1, 2, 3, 5, 6, 7, 10, 11, 12, 15, 16, 17)
    alternative = {
        **_raw(text, [(start, start + 0.4) for start in starts[: len(text.split())]]),
        "sourceId": "original",
        "cropStart": 0.0,
        "cropEnd": 20.0,
    }
    return {**primary, "alternatives": [alternative]}


def _worker(monkeypatch, *, recognition=None, recovered=None):
    calls = {"evidence": [], "alignments": []}
    events = list(zip(COMPLETE.split(), (1, 2, 3, 5, 6, 7, 10, 11, 12, 15, 16, 17)))
    scores = _scores([(word, start, 0.95) for word, start in events], duration=20)

    def evidence(*args, **kwargs):
        calls["evidence"].append(args[3])
        return scores, 0.02, []

    def alignment(_audio, _backing, _scores, _step, words, lyrics, *_args):
        calls["alignments"].append(lyrics)
        return SimpleNamespace(
            run=lambda *_args: {
                "words": [
                    {"text": word, "start": index, "end": index + 0.8, "confidence": 0.95}
                    for index, word in enumerate(words)
                ]
            }
        )

    monkeypatch.setattr(speech, "read_mono", lambda *_args: np.zeros(320_000, np.float32))
    monkeypatch.setattr(speech, "_alignment_evidence", evidence)
    monkeypatch.setattr(speech, "_AlignmentPass", alignment)
    monkeypatch.setattr(
        speech, "_accelerated_guidance", lambda *_a, **_k: pytest.fail("No second recognition")
    )
    if recovered is not None:
        monkeypatch.setattr(asr_recovery, "recover_lyrics", lambda *_args: recovered)
    result = speech.align(
        Path("vocal.wav"),
        EXPANDED,
        "English",
        recognition=recognition or _views(),
        asr_lyrics=True,
        asr_baseline=BASELINE,
    )
    assert len(calls["evidence"]) == 1
    assert len(calls["alignments"]) == 1
    return result


def test_native_floor_recovers_both_novel_words_and_repeat_in_one_worker_pass(monkeypatch):
    result = _worker(monkeypatch)
    assert result["lyrics"].split() == COMPLETE.split()
    assert [word["text"] for word in result["words"]] == COMPLETE.split()
    assert result["insertionsVerified"] is True


@pytest.mark.parametrize(
    ("second_view", "has_phonetic_support", "restored"),
    [
        ("birds fly softly", True, True),
        ("stars can shine", True, False),
        ("birds fly softly", False, False),
    ],
)
def test_native_asr_gap_needs_two_matching_crops_and_phonetic_support(
    monkeypatch, second_view, has_phonetic_support, restored
):
    starts = (1, 2, 3, 14, 15, 16)
    raw = _raw(BASELINE, [(start, start + 0.4) for start in starts])
    samples = np.full(18 * 16_000, 0.1, dtype=np.float32)
    phrase = "birds fly softly"
    evidence = [(word, start, 0.95) for word, start in zip(phrase.split(), (6, 7, 8))]
    scores = _scores(evidence if has_phonetic_support else [], duration=18)
    crops = iter([phrase, second_view])

    def decode(*_args, **_kwargs):
        return _raw(next(crops), [(start - 0.4, start) for start in (6, 7, 8)])

    def aligned(_audio, _backing, _scores, _step, words, _lyrics, *_other):
        return SimpleNamespace(run=lambda *_args: {"words": [{"text": word} for word in words]})

    monkeypatch.setattr(speech, "read_mono", lambda *_args: samples)
    monkeypatch.setattr(speech, "_alignment_evidence", lambda *_a, **_k: (scores, 0.02, []))
    monkeypatch.setattr(speech, "_accelerated_guidance", decode)
    monkeypatch.setattr(speech, "_AlignmentPass", aligned)

    result = speech.align(
        Path("vocal.wav"),
        BASELINE,
        "English",
        instrumental=Path("backing.wav"),
        recognition=dict(raw, sourceId="vocal"),
        asr_lyrics=True,
    )
    expected = BASELINE.replace("\n", f"\n{phrase}\n") if restored else BASELINE
    assert result["lyrics"] == expected
    assert [word["text"] for word in result["words"]] == expected.split()


@pytest.mark.parametrize(
    "recovered",
    [
        BASELINE,
        "stars guide us birds fly softly we sing aloud",
        "stars guide us we sing we sing aloud aloud",
    ],
)
def test_unoffered_old_repeat_keeps_the_expanded_text_for_existing_verification(
    monkeypatch, recovered
):
    result = _worker(monkeypatch, recovered=recovered)
    assert result["lyrics"] == EXPANDED
    assert [word["text"] for word in result["words"]] == EXPANDED.split()
    assert result["insertionsVerified"] is False


def test_real_candidate_without_the_old_repeat_falls_back_without_erasing_it(monkeypatch):
    result = _worker(monkeypatch, recognition=_views(added_repeat=False))
    assert result["lyrics"] == EXPANDED
    assert result["insertionsVerified"] is False


@pytest.mark.parametrize("verified", [False, True])
def test_document_passes_the_raw_floor_and_only_skips_repeat_verification_when_proven(
    tmp_path, monkeypatch, verified
):
    original, vocal = tmp_path / "original.wav", tmp_path / "vocal.wav"
    original.touch()
    song = replace(_song(original), duration=20)
    provider = FakeAiProvider()
    found = LyricsDiscovery(LocalSidecarLyricsReader(), (), LyricsMatchPolicy()).discover(
        song,
        vocal,
        provider,
        Event(),
        online_enabled=False,
        execution=EXECUTION,
        prepared=PreparedLyrics(None, (), (BASELINE, COMPLETE)),
    )
    assert found.source == "ASR" and found.repeat_baseline == BASELINE
    assert found.lyrics == EXPANDED
    requests = []

    def recover(_vocal, lyrics, *_args, baseline_lyrics="", **_kwargs):
        requests.append((lyrics, baseline_lyrics))
        accepted = COMPLETE if verified else EXPANDED
        return AlignedTranscript(
            accepted,
            tuple(WordTiming(word, i, i + 0.8, 0.95) for i, word in enumerate(accepted.split())),
            insertions_verified=verified,
        )

    monkeypatch.setattr(provider, "align_transcript", recover, raising=False)
    monkeypatch.setattr(provider, "align", lambda *_a, **_k: pytest.fail("Use transcript contract"))
    document = BuildProcessingDocument(
        Mock(), StageRunner(Mock(seconds=Mock(return_value=0.0))), Mock()
    )
    result, words = document._align(
        song,
        SimpleNamespace(reference_vocal=vocal, instrumental=None),
        found,
        ProcessingProviders(provider, provider, provider, provider),
        Mock(cancel=Event()),
        [],
        EXECUTION,
    )
    assert requests == [(EXPANDED, BASELINE)]
    assert result.lyrics == (COMPLETE if verified else EXPANDED)
    assert [word.text for word in words] == result.lyrics.split()
    assert result.source == "ASR" and result.repeat_baseline == BASELINE
    assert result.warnings == found.warnings


def test_fallback_still_rejects_an_unsupported_repeat_before_accepting_the_floor(
    tmp_path, monkeypatch
):
    from backend.lyrics.discovery import LyricsDiscoveryResult

    provider = FakeAiProvider()
    requests = []

    def recover(_vocal, lyrics, *_args, baseline_lyrics="", **_kwargs):
        requests.append((lyrics, baseline_lyrics))
        words = tuple(
            WordTiming(word, i, i + 0.8, 0.95 if i < len(BASELINE.split()) else 0.01)
            for i, word in enumerate(lyrics.split())
        )
        return AlignedTranscript(lyrics, words, insertions_verified=lyrics == BASELINE)

    monkeypatch.setattr(provider, "align_transcript", recover, raising=False)
    found = LyricsDiscoveryResult(
        EXPANDED, "ASR", ("LyricsRepeatsRecovered",), repeat_baseline=BASELINE
    )
    document = BuildProcessingDocument(
        Mock(), StageRunner(Mock(seconds=Mock(return_value=0.0))), Mock()
    )
    result, words = document._align(
        _song(None),
        SimpleNamespace(reference_vocal=tmp_path / "vocal.wav", instrumental=None),
        found,
        ProcessingProviders(provider, provider, provider, provider),
        Mock(cancel=Event()),
        [],
        EXECUTION,
    )
    assert requests == [(EXPANDED, BASELINE), (BASELINE, BASELINE)]
    assert result.lyrics == BASELINE
    assert [word.text for word in words] == BASELINE.split()
    assert result.warnings == ("UnverifiedExtraRepeats",)
    assert result.unverified_repeat_lyrics == EXPANDED


def test_custom_worker_preserves_the_expanded_text_and_old_protocol_with_a_floor():
    provider = _provider(b'{"words":[{"text":"sing","start":0,"end":1,"confidence":0.8}]}')
    result = provider.align_transcript(
        Path("voice.wav"),
        EXPANDED,
        Language.ENGLISH,
        Event(),
        execution=EXECUTION,
        baseline_lyrics=BASELINE,
    )
    command = provider._runner.command
    assert command[command.index("--lyrics") + 1] == EXPANDED
    assert "--asr-lyrics" not in command and "--asr-baseline" not in command
    assert result.lyrics == EXPANDED and result.insertions_verified is False


@pytest.mark.parametrize("verified", [False, True])
def test_local_worker_transmits_the_floor_and_explicit_verification_result(verified):
    from backend.serialization import dumps

    provider = _provider(
        dumps({"lyrics": COMPLETE, "words": [], "insertionsVerified": verified}).encode(),
        provider_id="local-torch",
    )
    result = provider.align_transcript(
        Path("voice.wav"),
        EXPANDED,
        Language.ENGLISH,
        Event(),
        execution=EXECUTION,
        baseline_lyrics=BASELINE,
    )
    command = provider._runner.command
    assert command[command.index("--lyrics") + 1] == EXPANDED
    assert command[command.index("--asr-baseline") + 1] == BASELINE
    assert result.insertions_verified is verified


def test_worker_cli_preserves_expanded_lyrics_and_dispatches_the_native_floor(monkeypatch):
    from backend.ai_worker import __main__ as cli

    calls = []
    monkeypatch.setattr(cli, "align", lambda *args, **kwargs: calls.append((args, kwargs)) or {})
    arguments = [
        "align",
        "--input",
        "vocal.wav",
        "--lyrics",
        EXPANDED,
        "--asr-lyrics",
        "--asr-baseline",
        BASELINE,
    ]
    cli._run(cli._parser().parse_args(arguments))
    assert calls[0][0][1] == EXPANDED
    assert calls[0][1]["asr_baseline"] == BASELINE
    assert calls[0][1]["asr_lyrics"] is True


def test_catalogue_hints_keep_the_existing_alignment_contract(tmp_path, monkeypatch):
    from backend.lyrics.discovery import LyricsDiscoveryResult

    provider = FakeAiProvider()
    calls = []
    hint = LyricLineTiming(1, BASELINE)
    monkeypatch.setattr(
        provider, "align_transcript", lambda *_a, **_k: pytest.fail("Catalogue"), raising=False
    )
    monkeypatch.setattr(provider, "align", lambda *_args, **kwargs: calls.append(kwargs) or ())
    document = BuildProcessingDocument(Mock(), Mock(), Mock())
    result = document._alignment_result(
        _song(None),
        SimpleNamespace(reference_vocal=tmp_path / "vocal.wav", instrumental=None),
        LyricsDiscoveryResult(BASELINE, "LocalSidecar", (), (hint,)),
        ProcessingProviders(provider, provider, provider, provider),
        Mock(cancel=Event()),
        EXECUTION,
    )
    assert calls[0]["timing_hints"] == (hint,)
    assert result.lyrics == BASELINE and result.insertions_verified is False
