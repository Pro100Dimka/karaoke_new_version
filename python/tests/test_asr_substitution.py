from __future__ import annotations

from copy import deepcopy

import pytest
import torch

from backend.ai_worker import ctc
from backend.ai_worker.asr_recovery import _path_score
from backend.ai_worker.asr_substitution import substitute_alignment


STEP = 0.02
BASELINE = "stars guide us\nmagic  \n"
CORRECTED = "stars guide us\nrain in calm air  \n"
ANCHORS = [("stars", 1.0, 1.4), ("guide", 2.0, 2.4), ("us", 3.0, 3.4)]
PHRASE = [("rain", 4.2, 4.6), ("in", 4.8, 5.0), ("calm", 5.2, 5.6), ("air", 5.8, 6.2)]


def _view(source, crop_start, words, *, shift=0.0, probability=0.9):
    return {
        "sourceId": source,
        "cropStart": crop_start,
        "cropEnd": 8.0,
        "text": " ".join(word for word, _start, _end in words),
        "segments": [
            {
                "words": [
                    {
                        "word": word,
                        "start": start + shift - crop_start,
                        "end": end + shift - crop_start,
                        "probability": probability,
                    }
                    for word, start, end in words
                ]
            }
        ],
    }


def _case():
    primary = [*ANCHORS, ("magic", 4.2, 5.6)]
    views = [
        _view("vocal", 0, primary, probability=0.2),
        _view("original", 0, [*ANCHORS, *PHRASE]),
        _view("vocal", 0.5, [*ANCHORS, *PHRASE], shift=0.02),
        _view("original", 0.5, [*ANCHORS, *PHRASE], shift=-0.02),
    ]
    words = [
        {
            "text": text,
            "start": start,
            "end": end,
            "confidence": 0.8,
            "letters": [start + index * 0.04 for index in range(len(text))],
            "diagnostics": ["RecognizedWord"],
            "retained": {"untouched": True},
        }
        for text, start, end in primary
    ]
    payload = {"words": words, "extra": {"keep": "exactly"}}
    return views, payload, _emission(PHRASE)


def _emission(words):
    probabilities = torch.full((400, 28), 1e-8)
    probabilities[:, 0] = 1
    for text, start, _end in words:
        tokens = [token for chars in ctc._character_tokens(text, text) for token in chars]
        for index, token in enumerate(tokens):
            frame = round((start + 0.04 + index * 0.04) / STEP)
            probabilities[frame, 0], probabilities[frame, token] = 0.1, 0.9
    return (probabilities / probabilities.sum(dim=1, keepdim=True)).log()


def test_native_consensus_replaces_only_one_final_occurrence_with_bounded_acoustic_cores():
    views, payload, scores = _case()
    saved_views, saved_payload, saved_scores = deepcopy(views), deepcopy(payload), scores.clone()

    lyrics, result = substitute_alignment(BASELINE, payload, views, scores, STEP, 8)

    assert lyrics == CORRECTED
    assert [word["text"] for word in result["words"]] == CORRECTED.split()
    assert result is not payload and result["extra"] is payload["extra"]
    assert all(a is b for a, b in zip(result["words"][:3], payload["words"][:3], strict=True))
    assert [word["start"] for word in result["words"][3:]] == pytest.approx(
        [4.24, 4.84, 5.24, 5.84]
    )
    assert result["words"][-1]["end"] < 6.2
    assert payload == saved_payload and views == saved_views and torch.equal(scores, saved_scores)


@pytest.mark.parametrize(
    "failure",
    [
        "one_source",
        "one_context",
        "duplicates",
        "uncrossed",
        "missing_probability",
        "missing_primary_probability",
        "strong_primary",
        "different_occurrence",
        "zero_duration",
        "blank",
        "unsupported_first",
        "unsupported_majority",
        "late_evidence",
        "unstable_neighbor",
        "crossed_neighbor",
        "ambiguous_occurrence",
        "payload_mismatch",
    ],
)
def test_uncorroborated_or_unsafe_substitution_preserves_the_original_payload(failure):
    views, payload, scores = _case()
    lyrics = BASELINE
    if failure == "one_source":
        views = [views[0], views[1], views[3]]
    elif failure == "one_context":
        views = [views[0], views[2], views[3]]
    elif failure == "duplicates":
        views = [views[0], views[1], deepcopy(views[1]), deepcopy(views[1])]
    elif failure == "uncrossed":
        views = views[:3]
    elif failure == "missing_probability":
        views[2]["segments"][0]["words"][-1].pop("probability")
    elif failure == "missing_primary_probability":
        views[0]["segments"][0]["words"][-1].pop("probability")
    elif failure == "strong_primary":
        views[0]["segments"][0]["words"][-1]["probability"] = 1
    elif failure == "different_occurrence":
        for word in views[2]["segments"][0]["words"][3:]:
            word["start"] += 1
            word["end"] += 1
    elif failure == "zero_duration":
        word = views[2]["segments"][0]["words"][-1]
        word["end"] = word["start"]
    elif failure in {"blank", "unsupported_first", "unsupported_majority", "late_evidence"}:
        first, last = {
            "blank": (0, 400),
            "unsupported_first": (210, 230),
            "unsupported_majority": (260, 310),
            "late_evidence": (210, 310),
        }[failure]
        scores[first:last] = scores[0].clone()
        if failure == "late_evidence":
            scores[340:360] = _case()[2][210:230]
    elif failure == "unstable_neighbor":
        payload["words"][2]["confidence"] = 0
    elif failure == "crossed_neighbor":
        payload["words"][2]["end"] = 4.5
        payload["words"][2]["letters"][-1] = 4.48
    elif failure == "ambiguous_occurrence":
        payload["words"].append(deepcopy(payload["words"][-1]))
        lyrics = BASELINE.rstrip() + " magic"
    elif failure == "payload_mismatch":
        payload["words"][-1]["text"] = "different"
    saved_views, saved_payload = deepcopy(views), deepcopy(payload)

    updated, result = substitute_alignment(lyrics, payload, views, scores, STEP, 8)

    assert updated == lyrics and result is payload
    assert views == saved_views and payload == saved_payload


def test_one_weak_function_word_keeps_its_real_low_confidence_and_review_diagnostics():
    views, payload, scores = _case()
    scores[240:250] = scores[0].clone()

    lyrics, result = substitute_alignment(BASELINE, payload, views, scores, STEP, 8)

    assert lyrics == CORRECTED
    weak = result["words"][4]
    assert weak["confidence"] < 0.1
    assert "LetterTimingReviewRequired" in weak["diagnostics"]
    assert "TimingReviewRequired" in weak["diagnostics"]


def test_substitution_never_uses_uniform_letter_timing_or_loads_a_model(monkeypatch):
    views, payload, scores = _case()

    def forbidden(*_args, **_kwargs):
        pytest.fail("Substitution must use existing acoustic frames")

    monkeypatch.setattr(ctc, "_evenly", forbidden)
    monkeypatch.setattr(ctc, "_model", forbidden)

    assert substitute_alignment(BASELINE, payload, views, scores, STEP, 8)[0] == CORRECTED


@pytest.mark.parametrize("primary_tail", ["sing", "magic"])
def test_each_acoustically_supported_primary_word_vetoes_its_deletion(primary_tail):
    removed = [("we", 4.2, 4.6), (primary_tail, 5.2, 5.6)]
    alternative = [("sing", 5.2, 5.6)]
    views = [
        _view("vocal", 0, [*ANCHORS, *removed], probability=0.2),
        _view("original", 0, [*ANCHORS, *alternative]),
        _view("vocal", 0.5, [*ANCHORS, *alternative], shift=0.02),
        _view("original", 0.5, [*ANCHORS, *alternative], shift=-0.02),
    ]
    _, payload, _ = _case()
    payload["words"][3:] = [
        {
            "text": word,
            "start": start,
            "end": end,
            "confidence": 0.8,
            "letters": [start + i * 0.04 for i in range(len(word))],
            "diagnostics": [],
        }
        for word, start, end in removed
    ]
    lyrics = f"stars guide us\nwe {primary_tail}  \n"
    scores = _emission([("we", 4.2, 4.6), *alternative])
    assert _path_score(scores[210:230], ["we"]) > _path_score(scores[210:230], ())
    if primary_tail == "magic":
        assert _path_score(scores[210:280], ["we", "magic"]) < _path_score(scores[210:280], ())

    text, result = substitute_alignment(lyrics, payload, views, scores, STEP, 8)

    assert text == lyrics and result is payload


def test_primary_text_sung_at_a_different_occurrence_does_not_veto_the_local_correction():
    views, payload, _ = _case()
    scores = _emission([*PHRASE, ("magic", 7.0, 7.4)])

    assert substitute_alignment(BASELINE, payload, views, scores, STEP, 8)[0] == CORRECTED


def _partial_case(primary, alternative, audible):
    views = [
        _view("vocal", 0, [*ANCHORS, *primary], probability=0.2),
        _view("original", 0, [*ANCHORS, *alternative]),
        _view("vocal", 0.5, [*ANCHORS, *alternative], shift=0.02),
        _view("original", 0.5, [*ANCHORS, *alternative], shift=-0.02),
    ]
    _, payload, _ = _case()
    payload["words"][3:] = [
        {
            "text": word,
            "start": start,
            "end": end,
            "confidence": 0.8,
            "letters": [start + i * 0.04 for i in range(len(word))],
            "diagnostics": [],
        }
        for word, start, end in primary
    ]
    lyrics = "stars guide us\n" + " ".join(word for word, _start, _end in primary)
    return lyrics, views, payload, _emission(audible)


def test_a_retained_strong_word_cannot_hide_an_unsupported_replacement():
    retained = ("rainbow", 5.2, 5.6)
    primary = [("magic", 4.2, 4.6), retained, ("ghost", 6.2, 6.6)]
    alternative = [("rain", 4.2, 4.6), retained, ("blue", 6.2, 6.6)]
    lyrics, views, payload, scores = _partial_case(primary, alternative, alternative[:2])

    text, result = substitute_alignment(lyrics, payload, views, scores, STEP, 8)

    assert text == lyrics and result is payload


def test_retained_words_are_not_misclassified_as_deleted_primary_words():
    primary = [("magic", 4.2, 5.6), PHRASE[-1]]
    lyrics, views, payload, scores = _partial_case(primary, PHRASE, PHRASE)
    views[0]["segments"][0]["words"][-1]["probability"] = 1

    text, result = substitute_alignment(lyrics, payload, views, scores, STEP, 8)

    assert text == CORRECTED.rstrip()
    assert [word["text"] for word in result["words"]] == text.split()
