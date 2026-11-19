from __future__ import annotations

from dataclasses import replace

import pytest
import torch
from torchaudio.pipelines import MMS_FA

from backend.ai_worker import asr_recovery
from backend.ai_worker.asr_candidates import AsrCandidate, AsrEvidence, TimedToken
from backend.ai_worker.ctc_tokens import _character_tokens

STEP = 0.02


def _scores(events, duration=4.0):
    labels = len(MMS_FA.get_dict(star=None))
    probabilities = torch.full((round(duration / STEP), labels), 0.01 / (labels - 1))
    probabilities[:, 0] = 0.99
    for text, start, strength in events:
        tokens = [token for letters in _character_tokens(text, text) for token in letters]
        for index, token in enumerate(tokens):
            frame = round(start / STEP) + 2 * index
            probabilities[frame] = (1 - strength - 0.01) / (labels - 2)
            probabilities[frame, 0] = 0.01
            probabilities[frame, token] = strength
    return probabilities.log()


def _proposal(*, first=1, last=1, primary=(), candidate=("can",), start=1.0, end=2.0, retained=()):
    observed = tuple(
        TimedToken(text, start + index * 0.1, start + (index + 1) * 0.1, "original", 1, index)
        for index, text in enumerate(candidate)
    )
    return AsrCandidate(
        first,
        last,
        primary,
        candidate,
        start,
        end,
        (),
        (),
        (AsrEvidence("original", 1, 0.0, 4.0, observed),),
        retained,
    )


def _recover(monkeypatch, scores, proposals, lyrics="we sing", step=STEP):
    monkeypatch.setattr(asr_recovery, "insertion_candidates", lambda *_args: tuple(proposals))
    return asr_recovery.recover_lyrics(lyrics, (), scores, step, 4.0)


def test_supported_insertion_uses_existing_ctc_without_erasing_primary_words(monkeypatch):
    scores = _scores([("we", 0.3, 0.95), ("can", 1.2, 0.95), ("sing", 2.5, 0.95)])
    assert _recover(monkeypatch, scores, [_proposal()]) == "we can sing"


@pytest.mark.parametrize("inserted_strength", [None, 0.08])
def test_blank_or_weak_added_words_do_not_pass_on_a_known_primary_word(
    monkeypatch, inserted_strength
):
    events = [("rainbow", 0.3, 0.95), ("sing", 2.5, 0.95)]
    if inserted_strength is not None:
        events.append(("can", 1.2, inserted_strength))
    proposal = _proposal(
        first=0, last=1, primary=("rainbow",), candidate=("rainbow", "can"), start=0, retained=(0,)
    )
    lyrics = "rainbow sing"
    assert _recover(monkeypatch, _scores(events), [proposal], lyrics) == lyrics


def test_each_new_run_requires_its_own_supported_entry(monkeypatch):
    scores = _scores(
        [("we", 0.3, 0.95), ("can", 1.2, 0.95), ("sing", 2.5, 0.95), ("now", 3.3, 0.08)]
    )
    proposal = _proposal(
        first=0,
        last=2,
        primary=("we", "sing"),
        candidate=("we", "can", "sing", "now"),
        start=0,
        end=4,
        retained=(0, 2),
    )
    assert _recover(monkeypatch, scores, [proposal]) == "we sing"


def test_a_weak_entry_is_not_hidden_by_a_strong_longer_following_word(monkeypatch):
    scores = _scores(
        [("we", 0.3, 0.95), ("can", 1.1, 0.08), ("always", 1.5, 0.95), ("sing", 2.5, 0.95)]
    )
    proposal = _proposal(candidate=("can", "always"))
    assert _recover(monkeypatch, scores, [proposal]) == "we sing"


def test_a_partial_crop_cannot_certify_the_whole_proposed_insertion(monkeypatch):
    scores = _scores([("we", 0.3, 0.95), ("can", 1.2, 0.95), ("sing", 2.5, 0.95)])
    proposal = _proposal()
    proposal = replace(proposal, evidence=(replace(proposal.evidence[0], crop_start=1.1),))
    assert _recover(monkeypatch, scores, [proposal]) == "we sing"


@pytest.mark.parametrize("candidate,retained", [(("can",), ()), (("We", "can"), (0,))])
def test_replacement_or_changed_primary_spelling_is_not_an_insertion(
    monkeypatch, candidate, retained
):
    scores = _scores([("we", 0.3, 0.95), ("can", 1.2, 0.95), ("sing", 2.5, 0.95)])
    proposal = _proposal(
        first=0, last=1, primary=("we",), candidate=candidate, start=0, retained=retained
    )
    assert _recover(monkeypatch, scores, [proposal]) == "we sing"


@pytest.mark.parametrize("side", ["left", "right"])
def test_an_insertion_cannot_borrow_the_supported_neighbors_phonemes(monkeypatch, side):
    scores = _scores([("cat", 0.3, 0.95), ("sing", 2.5, 0.95)])
    proposal = (
        _proposal(candidate=("at",), start=0.3, end=1.0)
        if side == "left"
        else _proposal(candidate=("sin",), start=1.8, end=3.0)
    )
    proposal = replace(
        proposal,
        left_context=(TimedToken("cat", 0.3, 0.4, "vocal", 0, 0),),
        right_context=(TimedToken("sing", 2.5, 2.7, "vocal", 0, 1),),
    )
    assert _recover(monkeypatch, scores, [proposal], "cat sing") == "cat sing"


def test_a_displaced_primary_core_cannot_cut_the_independently_heard_insertion(monkeypatch):
    scores = _scores([("rain", 1.2, 0.95), ("sing", 2.5, 0.95)])
    proposal = replace(
        _proposal(candidate=("rain",)),
        right_context=(TimedToken("sing", 2.5, 2.7, "vocal", 0, 1),),
    )
    # With the verse absent, whole-song CTC borrows the "a" inside "rain".
    # No shared recognition context confirms that preceding word as an anchor.
    assert _recover(monkeypatch, scores, [proposal], "a sing") == "a rain sing"


def test_conflicting_shared_neighbor_timing_defers_an_ambiguous_insertion(monkeypatch):
    scores = _scores([("cat", 1.2, 0.95), ("sing", 2.5, 0.95)])
    proposal = replace(
        _proposal(candidate=("at",)),
        left_context=(TimedToken("cat", 0.2, 0.3, "vocal", 0, 0),),
        right_context=(TimedToken("sing", 2.5, 2.7, "vocal", 0, 1),),
    )
    # The proposed word reuses two phonemes of a real neighbour. The shared
    # context's time is not acoustically confirmed, so it cannot certify a gap.
    assert _recover(monkeypatch, scores, [proposal], "cat sing") == "cat sing"


@pytest.mark.parametrize("kind", ["empty", "nan", "short", "zero-step"])
def test_invalid_or_infeasible_emissions_leave_the_original_text(monkeypatch, kind):
    scores = _scores([("we", 0.3, 0.95), ("can", 1.2, 0.95), ("sing", 2.5, 0.95)])
    if kind == "empty":
        scores = scores[:0]
    elif kind == "nan":
        scores[:] = float("nan")
    elif kind == "short":
        scores = scores[:1]
    assert (
        _recover(monkeypatch, scores, [_proposal()], step=0 if kind == "zero-step" else STEP)
        == "we sing"
    )


def test_rejected_edits_do_not_normalize_existing_line_breaks(monkeypatch):
    lyrics = "\twe\n\nsing  \n"
    scores = _scores([("we", 0.3, 0.95), ("sing", 2.5, 0.95)])
    assert _recover(monkeypatch, scores, [_proposal()], lyrics) == lyrics


def test_accepted_edit_preserves_whitespace_outside_its_span_and_is_not_duplicated(monkeypatch):
    lyrics = "\twe\n\nsing  \n"
    scores = _scores([("we", 0.3, 0.95), ("can", 1.2, 0.95), ("sing", 2.5, 0.95)])
    proposal = _proposal()
    assert _recover(monkeypatch, scores, [proposal, proposal], lyrics) == "\twe\n\ncan sing  \n"


def _native_view(source, words):
    return {
        "sourceId": source,
        "text": " ".join(word for word, _start in words),
        "segments": [
            {
                "words": [
                    {"word": word, "start": start, "end": start + 0.4}
                    for word, start in words
                ]
            }
        ],
    }


def test_separate_supported_islands_at_one_insertion_position_keep_their_temporal_order():
    first = list(zip("we sail home".split(), [1.0, 2.0, 3.0], strict=True))
    second = list(zip("birds sing softly".split(), [9.0, 10.0, 11.0], strict=True))
    anchor = list(zip("stars guide us".split(), [20.0, 21.0, 22.0], strict=True))
    views = [_native_view("vocal", anchor), _native_view("original", [*first, *second, *anchor])]
    scores = _scores([(word, start, 0.95) for word, start in [*first, *second, *anchor]], 30)
    proposals = asr_recovery.insertion_candidates("stars guide us", views, 30)
    assert len(proposals) == 2 and all(item.first == item.last == 0 for item in proposals)
    assert proposals[0].end < proposals[1].start
    assert all(asr_recovery._accept(item, scores, STEP) is not None for item in proposals)

    result = asr_recovery.recover_lyrics("stars guide us", views, scores, STEP, 30)

    assert result == "we sail home birds sing softly stars guide us"


@pytest.mark.parametrize("alternative", ["can", "could"])
def test_overlapping_observations_at_one_position_cannot_duplicate_an_occurrence(
    monkeypatch, alternative
):
    events = [("we", 0.3, 0.95), ("can", 1.2, 0.95), ("sing", 2.5, 0.95)]
    if alternative != "can":
        events.append((alternative, 1.5, 0.95))
    scores = _scores(events)
    proposals = [_proposal(), _proposal(candidate=(alternative,), start=1.1)]
    assert all(asr_recovery._accept(item, scores, STEP) is not None for item in proposals)

    result = _recover(monkeypatch, scores, proposals)

    assert result in {"we can sing", f"we {alternative} sing"}


def test_recovery_never_uses_uniform_timing_when_the_lattice_is_infeasible(monkeypatch):
    from backend.ai_worker import ctc

    monkeypatch.setattr(
        ctc,
        "_evenly",
        lambda *_args, **_kwargs: pytest.fail("Uniform timing is not acoustic proof"),
    )
    assert _recover(monkeypatch, _scores([])[:1], [_proposal()]) == "we sing"
