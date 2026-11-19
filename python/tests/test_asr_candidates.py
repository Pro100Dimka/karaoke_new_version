from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from backend.ai_worker.asr_candidates import insertion_candidates


def view(source, words, *, start=0.0, end=None):
    result = {
        "sourceId": source,
        "cropStart": start,
        "text": " ".join(word for word, _, _ in words),
        "segments": [
            {
                "words": [
                    {"word": word, "start": first - start, "end": last - start}
                    for word, first, last in words
                ]
            }
        ],
    }
    if end is not None:
        result["cropEnd"] = end
    return result


def phrase(text, start):
    return [(word, start + index, start + index + 0.4) for index, word in enumerate(text.split())]


def test_original_only_phrase_proposes_insertion_preserving_literal_baseline():
    entry = phrase("We sail home", 8)
    anchor = phrase("Stars guide us", 18)
    primary = view("vocal", [*entry, *anchor])
    original = view("original", [*entry, *phrase("through silver rain", 12), *anchor])

    proposals = insertion_candidates("We sail home\nStars guide us", [primary, original], 30)

    assert len(proposals) == 1
    proposal = proposals[0]
    assert proposal.first == proposal.last == 3
    assert proposal.primary == ()
    assert proposal.retained_positions == ()
    assert proposal.candidate == ("through", "silver", "rain")
    assert proposal.text == "through silver rain"
    assert proposal.start <= 12 < 14.4 <= proposal.end
    assert proposal.left_context and proposal.right_context
    assert proposal.evidence[0].source_id == "original"


def test_collapsed_primary_proposes_only_one_contiguous_matching_phrase():
    primary = view(
        "vocal",
        [
            *(
                (word, 12 + i * 0.02, 12 + (i + 1) * 0.02)
                for i, word in enumerate("We sail home".split())
            ),
            *phrase("Stars guide us", 18),
        ],
    )
    original = view(
        "original",
        [
            *phrase("we sail home", 4),
            *phrase("through silver rain", 8),
            *phrase("Stars guide us", 18),
        ],
    )

    proposals = insertion_candidates("We sail home\nStars guide us", [primary, original], 30)

    assert len(proposals) == 1
    assert proposals[0].retained_positions == (0, 1, 2)
    assert proposals[0].primary == ("We", "sail", "home")
    assert proposals[0].candidate == ("We", "sail", "home", "through", "silver", "rain")


@pytest.mark.parametrize("primary_word, observed_word", [("café", "cafe"), ("naïve", "naive")])
def test_collapsed_diacritic_variant_preserves_literal_primary(primary_word, observed_word):
    baseline = f"At the {primary_word}"
    ending = phrase("Stars guide us", 18)
    primary = view(
        "vocal",
        [
            (word, 12 + i * 0.02, 12 + (i + 1) * 0.02)
            for i, word in enumerate(baseline.split())
        ]
        + ending,
    )
    original = view(
        "original",
        [*phrase(f"at the {observed_word}", 4), *phrase("we sing softly", 8), *ending],
    )

    proposals = insertion_candidates(f"{baseline}\nStars guide us", [primary, original], 30)

    assert len(proposals) == 1
    assert proposals[0].primary == ("At", "the", primary_word)
    assert proposals[0].retained_positions == (0, 1, 2)
    assert proposals[0].candidate == ("At", "the", primary_word, "we", "sing", "softly")
    assert proposals[0].evidence[0].observed[2].text == observed_word


def test_collapsed_diacritic_variants_cannot_hide_a_second_matching_block():
    ending = phrase("Stars guide us", 20)
    primary = view(
        "vocal",
        [
            (word, 11 + i * 0.02, 11 + (i + 1) * 0.02)
            for i, word in enumerate("At the café".split())
        ]
        + ending,
    )
    original = view(
        "original", [*phrase("at the café at the cafe we sing softly", 4), *ending]
    )

    assert insertion_candidates("At the café\nStars guide us", [primary, original], 30) == ()


def test_collapsed_primary_with_repeated_contiguous_block_is_ambiguous():
    ending = phrase("Stars guide us", 20)
    primary = view(
        "vocal",
        [
            (word, 11 + i * 0.02, 11 + (i + 1) * 0.02)
            for i, word in enumerate("We sail home".split())
        ]
        + ending,
    )
    original = view(
        "original", [*phrase("we sail home we sail home through silver rain", 4), *ending]
    )

    assert insertion_candidates("We sail home Stars guide us", [primary, original], 30) == ()


def test_normal_primary_timing_does_not_use_the_collapsed_phrase_exception():
    ending = phrase("Stars guide us", 18)
    primary = view("vocal", [*phrase("We sail home", 12), *ending])
    original = view(
        "original", [*phrase("we sail home", 4), *phrase("through silver rain", 8), *ending]
    )

    assert insertion_candidates("We sail home Stars guide us", [primary, original], 30) == ()


def test_equal_word_elsewhere_in_one_disputed_gap_cannot_replace_its_occurrence():
    entry, ending = phrase("We sail away", 1), phrase("Stars guide us", 20)
    primary = view("vocal", [*entry, *phrase("home", 10), *ending])
    original = view("original", [*entry, *phrase("drift over quiet water home under", 10), *ending])

    assert insertion_candidates("We sail away home Stars guide us", [primary, original], 30) == ()


@pytest.mark.parametrize("native", ["We-sail-home", "We%sail%home", "We sail home"])
def test_one_native_observation_cannot_become_several_anchor_words(native):
    primary = view("vocal", phrase("We sail home", 5))
    original = view("original", [(native, 5, 7.4), *phrase("through silver rain", 10)])

    assert insertion_candidates("We sail home", [primary, original], 30) == ()


def test_numeric_decoder_annotation_cannot_become_a_lyric_insertion():
    primary = view("vocal", phrase("We sail home", 5))
    original = view("original", [*phrase("We sail home", 5), ("123", 10, 10.4)])

    assert insertion_candidates("We sail home", [primary, original], 30) == ()


def test_local_timed_spelling_disagreement_preserves_primary_form():
    primary = view("vocal", [*phrase("At the café", 5), *phrase("Stars guide us", 18)])
    original = view(
        "original",
        [*phrase("at the cafe", 5), *phrase("we sing softly", 9), *phrase("Stars guide us", 18)],
    )

    proposals = insertion_candidates("At the café\nStars guide us", [primary, original], 30)

    assert len(proposals) == 1
    assert proposals[0].candidate == ("At", "the", "café", "we", "sing", "softly")
    assert proposals[0].primary == ("At", "the", "café")
    assert proposals[0].retained_positions == (0, 1, 2)


def test_unrelated_replacement_does_not_become_an_insertion():
    primary = view("vocal", [*phrase("Stars guide us", 5), *phrase("wonderland", 10)])
    original = view("original", [*phrase("Stars guide us", 5), *phrase("truth in quiet words", 10)])

    assert insertion_candidates("Stars guide us wonderland", [primary, original], 20) == ()


def test_isolated_alternate_credit_is_not_bundled_with_a_missing_verse():
    primary = view("vocal", phrase("Stars guide us", 20))
    original = view(
        "original",
        [*phrase("credit", 1), *phrase("we sail home", 10), *phrase("Stars guide us", 20)],
    )

    proposals = insertion_candidates("Stars guide us", [primary, original], 30)

    assert [item.candidate for item in proposals] == [("credit",), ("we", "sail", "home")]
    assert proposals[0].end < proposals[1].start


def test_distant_repeated_text_does_not_supply_a_matching_occurrence():
    primary = view("vocal", phrase("We sing again", 5))
    unrelated = view("original", [*phrase("we sing again", 50), *phrase("new words here", 55)])

    assert insertion_candidates("We sing again", [primary, unrelated], 70) == ()


def test_partial_crop_cannot_replace_the_whole_gap_or_supply_missing_prefix():
    primary = view("vocal", [*phrase("We sail home", 5), *phrase("Stars guide us", 20)])
    full = view(
        "original",
        [
            *phrase("We sail home", 5),
            *phrase("through silver rain", 9),
            *phrase("Stars guide us", 20),
        ],
    )
    tail = view("original", [*phrase("silver rain", 10), *phrase("Stars guide us", 20)], start=10)

    proposals = insertion_candidates("We sail home Stars guide us", [primary, full, tail], 30)

    assert len(proposals) == 1
    assert proposals[0].candidate == ("through", "silver", "rain")
    assert [(item.source_id, item.crop_start) for item in proposals[0].evidence] == [
        ("original", 0)
    ]


def test_same_source_crop_duplicate_does_not_create_an_extra_observation():
    primary = view("vocal", phrase("Stars guide us", 5))
    other = view("original", [*phrase("Stars guide us", 5), *phrase("we sail home", 10)])
    independent = view(
        "vocal", [*phrase("Stars guide us", 5), *phrase("we sail home", 10)], start=4
    )

    proposal = insertion_candidates("Stars guide us", [primary, other, other, independent], 25)[0]

    assert len(proposal.evidence) == 2
    assert {item.source_id for item in proposal.evidence} == {"original", "vocal"}
    assert {item.crop_start for item in proposal.evidence} == {0, 4}


def test_open_ending_uses_recording_boundary_and_crop_offset_once():
    primary = view("vocal", phrase("Stars guide us", 15))
    tail = view("original", [*phrase("Stars guide us", 15), *phrase("we sail home", 20)], start=12)

    proposal = insertion_candidates("Stars guide us", [primary, tail], 40)[0]

    assert proposal.end == 40
    assert proposal.evidence[0].observed[0].start == 20
    assert proposal.evidence[0].crop_start == 12
    assert proposal.evidence[0].crop_end == 40


def test_nonpositive_native_tokens_never_become_candidate_words_or_anchors():
    primary = view("vocal", phrase("Stars guide us", 5))
    original = view("original", [*phrase("Stars guide us", 5), ("invented", 12, 12)])

    assert insertion_candidates("Stars guide us", [primary, original], 20) == ()


@pytest.mark.parametrize("lyrics", ["Stars guide us\nStars guide us", "Changed guide us"])
def test_baseline_not_represented_by_primary_view_fails_closed(lyrics):
    primary = view("vocal", phrase("Stars guide us", 5))
    original = view("original", [*phrase("Stars guide us", 5), *phrase("we sail home", 10)])

    assert insertion_candidates(lyrics, [primary, original], 20) == ()


def test_candidate_and_provenance_are_immutable():
    primary = view("vocal", phrase("Stars guide us", 5))
    original = view("original", [*phrase("Stars guide us", 5), *phrase("we sail home", 10)])
    proposal = insertion_candidates("Stars guide us", [primary, original], 20)[0]

    with pytest.raises(FrozenInstanceError):
        proposal.end = 21
    with pytest.raises(FrozenInstanceError):
        proposal.evidence[0].source_id = "changed"
