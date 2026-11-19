from __future__ import annotations

from copy import deepcopy
from threading import Event
from types import SimpleNamespace

import numpy as np
import pytest
import torch

from backend.ai_worker import acoustic_retry, asr_recovery, speech
from backend.ai_worker.asr_views import read_views
from backend.lyrics.discovery import lyrics_language
from backend.serialization import dumps
from backend.songs.domain import Language
from backend.text_normalization import clean_lyrics
from tests.test_asr_recovery import _scores
from tests.test_command_ai_provider import EXECUTION, _provider


def _raw(text, intervals=None):
    tokens = text.split()
    spans = intervals or [(index + 1.0, index + 1.4) for index in range(len(tokens))]
    return {
        "text": text,
        "segments": [
            {
                "text": text,
                "words": [
                    {"word": token, "start": start, "end": end}
                    for token, (start, end) in zip(tokens, spans, strict=True)
                ],
            }
        ],
    }


def _align(
    monkeypatch,
    vocal,
    lyrics,
    fresh,
    *,
    recognition=None,
    language="English",
    accepted=None,
    actual_recovery=False,
    silent_backing=False,
    scores=None,
):
    audio = np.full(160_000, 0.2, dtype=np.float32)
    backing = np.full_like(audio, 0 if silent_backing else 0.05)
    calls, observed, retry_views = [], [], []
    recover = asr_recovery.recover_lyrics

    def recognize(source, *_args, **_options):
        calls.append(source)
        return fresh[len(calls) - 1]

    def resolve(text, views, *args):
        observed.extend(deepcopy(views))
        return recover(text, views, *args) if actual_recovery else accepted or text

    def retry(_audio, scores, _step, _lyrics, views, _emit):
        retry_views.extend(deepcopy(views))
        return scores

    def final_pass(_audio, _backing, _scores, _step, words, *_args):
        return SimpleNamespace(run=lambda *_args: {"words": [{"text": word} for word in words]})

    monkeypatch.setattr(
        speech, "read_mono", lambda source, _rate: audio if source == vocal else backing
    )
    monkeypatch.setattr(speech, "cpu_threads", lambda: 1)
    monkeypatch.setattr(speech, "_guidance", recognize)
    monkeypatch.setattr(
        speech,
        "_alignment_emission",
        lambda *_args: (torch.zeros(500, 28) if scores is None else scores, 0.02),
    )
    monkeypatch.setattr(acoustic_retry, "recover_emission", retry)
    monkeypatch.setattr(asr_recovery, "recover_lyrics", resolve)
    monkeypatch.setattr(speech, "_AlignmentPass", final_pass)
    result = speech.align(
        vocal,
        lyrics,
        language,
        instrumental=vocal.with_name("backing.wav"),
        recognition=recognition,
        asr_lyrics=True,
    )
    assert len(calls) == len(fresh), "Metadata must use only the already required recognitions"
    return result, observed, retry_views


@pytest.mark.parametrize(
    "baseline,complete,detected",
    [
        ("мы поём над рекой светит луна", "мы снова поём над рекой светит луна", Language.RUSSIAN),
        (
            "ми співаємо над річкою сяє місяць",
            "ми знову співаємо над річкою сяє місяць",
            Language.UKRAINIAN,
        ),
    ],
)
def test_language_cache_miss_keeps_fresh_recognitions_for_asr_recovery(
    tmp_path, monkeypatch, baseline, complete, detected
):
    vocal = tmp_path / "vocal.wav"
    vocal.write_bytes(b"synthetic audio identity")
    song = SimpleNamespace(artist="Example", title="River", language=Language.AUTO)
    before, after = lyrics_language(song), lyrics_language(song, baseline)
    assert before is Language.AUTO and after is detected
    provider = _provider(dumps(_raw(baseline)).encode(), provider_id="local-torch")
    cancel = Event()
    provider.transcribe(vocal, before, cancel, execution=EXECUTION)
    recognition = provider._recognition_for(vocal, after, cancel, EXECUTION, with_sources=True)
    assert recognition is None, "A changed language must continue to invalidate the cache"
    fresh = [_raw(baseline), _raw(complete)]
    original = deepcopy(fresh)

    result, observed, _ = _align(
        monkeypatch, vocal, baseline, fresh, language=after.value, accepted=complete
    )

    assert result["lyrics"] == complete
    assert [word["text"] for word in result["words"]] == complete.split()
    assert [view["text"] for view in observed] == [baseline, complete]
    assert len({view["sourceId"] for view in observed}) == 2
    assert [(view["cropStart"], view["cropEnd"]) for view in observed] == [(0, 10)] * 2
    assert [view["segments"] for view in observed] == [view["segments"] for view in fresh]
    assert fresh == original


def test_cached_primary_keeps_the_fresh_reconstructed_mix(tmp_path, monkeypatch):
    vocal = tmp_path / "vocal.wav"
    baseline, complete = "we sing over quiet water", "we still sing over quiet water"
    primary = {**_raw(baseline), "sourceId": "cached-vocal", "cropStart": 0.0}
    before = deepcopy(primary)
    alternative = _raw(complete)

    result, observed, retry_views = _align(
        monkeypatch, vocal, baseline, [alternative], recognition=primary, accepted=complete
    )

    assert result["lyrics"] == complete
    assert [view["text"] for view in observed] == [baseline, complete]
    assert observed[0] == primary
    assert observed[1]["sourceId"] != primary["sourceId"]
    assert (observed[1]["cropStart"], observed[1]["cropEnd"]) == (0, 10)
    assert observed[1]["segments"] == alternative["segments"]
    assert len(retry_views) == 2, "The fresh full mix is independent acoustic evidence too"
    assert primary == before


def test_cached_tail_is_not_replaced_by_reconstructed_prefixes(tmp_path, monkeypatch):
    baseline = "we sing over quiet water"
    tail = {
        **_raw("water", [(0.5, 1.0)]),
        "sourceId": "original",
        "cropStart": 8.0,
        "startSeconds": 8.0,
    }
    primary = {
        **_raw(baseline),
        "sourceId": "vocal",
        "cropStart": 0.0,
        "alternatives": [tail],
    }
    before = deepcopy(primary)

    _, observed, retry_views = _align(
        monkeypatch, tmp_path / "vocal.wav", baseline, [], recognition=primary
    )

    assert observed == [primary, tail]
    parsed = read_views(observed, 10.0)
    assert len(parsed) == 2
    assert (parsed[1].tokens[0].start, parsed[1].tokens[0].end) == (8.5, 9.0)
    assert len(retry_views) == 1
    assert primary == before


@pytest.mark.parametrize(
    "raw",
    [
        _raw("we, 1.5% sing!"),
        _raw("we sing we sing", [(1, 2), (2, 3), (3, 3), (3, 3)]),
        _raw("we're still singing"),
    ],
    ids=["numeric-annotation", "collapsed-decoder-tail", "apostrophe"],
)
def test_fresh_text_uses_the_same_transcription_and_lyric_cleanup(tmp_path, monkeypatch, raw):
    vocal = tmp_path / "vocal.wav"
    monkeypatch.setattr(speech, "_guidance", lambda *_args, **_kwargs: raw)
    expected = clean_lyrics(speech.transcribe(vocal, "English")["text"], "English")
    before = deepcopy(raw)

    _, observed, _ = _align(monkeypatch, vocal, expected, [raw, raw])

    assert len(observed) == 2
    assert [view["text"] for view in observed] == [expected, expected]
    assert all(view["segments"] == raw["segments"] for view in observed)
    assert raw == before


def test_fresh_primary_mismatch_preserves_the_exact_baseline(tmp_path, monkeypatch):
    baseline = "\twe\n\nsing over quiet water  \n"
    monkeypatch.setattr(
        asr_recovery, "_accept", lambda *_args: pytest.fail("Mismatched primary is not a proposal")
    )

    result, observed, _ = _align(
        monkeypatch,
        tmp_path / "vocal.wav",
        baseline,
        [_raw("they dance under a moon"), _raw("they still dance under a moon")],
        actual_recovery=True,
    )

    assert len(observed) == 2
    assert result["lyrics"] == baseline


def test_fresh_native_views_recover_an_insertion_with_existing_ctc(tmp_path, monkeypatch):
    baseline, complete = "we sing over quiet water", "we still sing over quiet water"
    starts = [1.0, 3.0, 4.0, 5.0, 6.0]
    primary = _raw(baseline, [(start, start + 0.4) for start in starts])
    alternative = _raw(complete)
    scores = _scores(
        [(word, index + 1.0, 0.95) for index, word in enumerate(complete.split())], duration=10
    )

    result, observed, _ = _align(
        monkeypatch,
        tmp_path / "vocal.wav",
        baseline,
        [primary, alternative],
        actual_recovery=True,
        scores=scores,
    )

    assert len(observed) == 2
    assert result["lyrics"] == complete
    assert [word["text"] for word in result["words"]] == complete.split()


@pytest.mark.parametrize("cached", [False, True])
def test_identical_fresh_audio_is_not_given_an_independent_source(tmp_path, monkeypatch, cached):
    baseline = "we sing over quiet water"
    primary = {**_raw(baseline), "sourceId": "cached-vocal", "cropStart": 0.0} if cached else None

    _, observed, _ = _align(
        monkeypatch,
        tmp_path / "vocal.wav",
        baseline,
        [_raw(baseline)] * (1 if cached else 2),
        recognition=primary,
        silent_backing=True,
    )

    assert len(observed) == 2
    assert len({view["sourceId"] for view in observed}) == 1
    assert len(read_views(observed, 10.0)) == 1
