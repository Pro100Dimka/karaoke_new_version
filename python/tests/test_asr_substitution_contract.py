from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
import torch

from backend.ai_worker import asr_substitution, speech


@pytest.mark.parametrize(
    ("asr_lyrics", "verified", "corrected"),
    [(True, True, True), (True, False, False), (False, False, False)],
)
def test_consensus_correction_follows_alignment_only_after_asr_repeat_verification(
    monkeypatch, tmp_path, asr_lyrics, verified, corrected
):
    samples = np.zeros(32_000, dtype=np.float32)
    scores = torch.zeros(100, 28)
    primary = {"sourceId": "vocal", "text": "quiet words", "segments": []}
    alternative = {"sourceId": "original", "text": "clear words", "segments": []}
    fresh = {"sourceId": "reconstructed", "text": "clear words", "segments": []}
    recognition = dict(primary, alternatives=[alternative])
    original = {"words": [{"text": "quiet"}, {"text": "words"}]}
    replacement = {"words": [{"text": "clear"}, {"text": "words"}]}
    calls = []

    def evidence(*_args, **kwargs):
        if "observations" in kwargs:
            kwargs["observations"].views.append(fresh)
        return scores, 0.02, []

    def aligned(*_args):
        calls.append("alignment")
        return original

    def substitute(lyrics, payload, views, actual_scores, step, duration):
        calls.append("substitution")
        assert lyrics == "quiet words" and payload is original
        assert views == [recognition, alternative, fresh]
        assert actual_scores is scores and step == 0.02 and duration == 2
        return "clear words", replacement

    monkeypatch.setattr(speech, "read_mono", lambda *_args: samples)
    monkeypatch.setattr(speech, "_alignment_evidence", evidence)
    monkeypatch.setattr(
        speech, "_recover_transcript_lyrics", lambda *_args: ("quiet words", verified)
    )
    monkeypatch.setattr(speech, "_AlignmentPass", lambda *_args: SimpleNamespace(run=aligned))
    monkeypatch.setattr(asr_substitution, "substitute_alignment", substitute)

    result = speech.align(
        tmp_path / "vocal.wav",
        "quiet words",
        "English",
        recognition=recognition,
        asr_lyrics=asr_lyrics,
    )

    assert calls == (["alignment", "substitution"] if corrected else ["alignment"])
    expected = replacement if corrected else original
    assert result["words"] is expected["words"]
    if asr_lyrics:
        assert result["lyrics"] == ("clear words" if corrected else "quiet words")
        assert result["insertionsVerified"] is verified
    else:
        assert result == original
