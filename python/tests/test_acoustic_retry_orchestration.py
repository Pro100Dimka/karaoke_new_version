from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import torch

from backend.ai_worker import acoustic_retry, speech


def _native_view(source, *, shift=0.0, crop_start=0.0):
    text = "we sing over quiet water"
    words = [
        {"word": word, "start": index + 1.0 + shift, "end": index + 1.4 + shift}
        for index, word in enumerate(text.split())
    ]
    return {
        "sourceId": source,
        "cropStart": crop_start,
        "startSeconds": crop_start,
        "cropEnd": 10.0,
        "text": text,
        "segments": [{"text": text, "words": words}],
    }


@pytest.mark.parametrize("accepted", [False, True], ids=["rejected", "accepted"])
def test_alignment_retries_only_native_full_views_before_releasing_the_model(monkeypatch, accepted):
    samples = np.arange(160_000, dtype=np.float32)
    bounded = samples[32_000:64_000]
    scores = torch.zeros(500, 28)
    original_scores = scores.clone()
    local_scores = torch.ones(100, 28)
    repaired = scores.clone()
    repaired[100:200] = local_scores
    reuse = object()
    events = []
    vocal = _native_view("vocal")
    original = _native_view("original", shift=0.02)
    tail = _native_view("original", crop_start=8.0)
    recognition = {**vocal, "alternatives": [original, tail]}
    original_recognition = deepcopy(recognition)
    full = [speech.heard_words(vocal), speech.heard_words(original)]
    stitched = [*full[0][:-1], ("water", 8.5, 9.0)]
    candidates = [*full, stitched, list(stitched)]
    independent_views = []

    def emission(audio, reuse=None):
        assert reuse is reuse_token
        assert "clear" not in events, "MMS must stay available for the bounded retry"
        if audio is samples:
            events.append("full")
            return scores, 0.02
        assert audio is bounded, "The retry callback must forward the supplied bounded audio"
        events.append("bounded")
        return local_scores, 0.02

    def retry(audio, old_scores, step, lyrics, views, emit):
        assert audio is samples and old_scores is scores
        assert step == 0.02 and lyrics == vocal["text"]
        assert views == full, "Stitched prefixes and cropped tails are not independent full views"
        assert events == ["full"]
        events.append("retry")
        local, local_step = emit(bounded)
        assert local is local_scores and local_step == step
        return repaired if accepted else old_scores

    reuse_token = reuse
    monkeypatch.setattr(speech, "independent_words", lambda *_args: candidates)
    monkeypatch.setattr(speech, "cpu_threads", lambda: 1)
    monkeypatch.setattr(speech.torch, "set_num_threads", lambda _threads: None)
    monkeypatch.setattr(speech, "_alignment_emission", emission)
    monkeypatch.setattr(acoustic_retry, "recover_emission", retry)
    monkeypatch.setattr(
        speech, "alignment_model", SimpleNamespace(cache_clear=lambda: events.append("clear"))
    )

    result, step, heard = speech._alignment_evidence(
        Path("vocal.wav"),
        samples,
        "English",
        vocal["text"],
        recognition=recognition,
        independent_views=independent_views,
        reuse=reuse,
    )

    assert events == ["full", "retry", "bounded", "clear"]
    assert result is (repaired if accepted else scores) and step == 0.02
    assert heard in full
    assert independent_views == candidates, "Ordinary alignment retains its existing candidates"
    assert recognition == original_recognition
    assert torch.equal(scores, original_scores), "An optional retry must not mutate cached scores"
