from __future__ import annotations

from dataclasses import replace

import pytest

from backend.ai_worker import speech_windows
from backend.ai_worker.ctc import AlignedWord


_REFRAIN = "silver river home silver river home silver river home again"


def _timed_lines(lines, starts):
    return [
        AlignedWord(text, start + offset * 0.5, start + offset * 0.5 + 0.4, (), 0.7)
        for line, start in zip(lines, starts, strict=True)
        for offset, text in enumerate(line.split())
    ]


def _internal_motif_case(shift=0.0):
    lines = [
        "early amber lights",
        "quiet windows open",
        "distant footsteps fade",
        "morning voices answer",
        *[_REFRAIN] * 3,
    ]
    cues = [1.0, 3.0, 5.0, 7.0, 10.0, 20.0, 50.0]
    hints = [{"start": start, "text": line} for line, start in zip(lines, cues, strict=True)]
    actual = _timed_lines(lines, [start + shift for start in cues])
    whole = _timed_lines(lines, [start + shift for start in [*cues[:-1], 23.0]])
    # The full-song path compresses the previous phrase, making its third
    # internal motif closer to the next written occurrence than its own words.
    for offset in range(4):
        index = 28 + offset
        whole[index] = replace(
            whole[index], start=22.6 + shift + offset * 0.1, end=22.65 + shift + offset * 0.1
        )
    heard = [(word.text, word.start, word.end) for word in actual[:-10]]
    return "\n".join(lines).split(), hints, whole, heard


@pytest.mark.parametrize("shift", [0.0, 0.4, 2.5])
def test_an_internal_motif_cannot_supply_a_second_catalogue_occurrence(shift):
    words, hints, whole, heard = _internal_motif_case(shift)
    supported = speech_windows._heard_timings(words, heard, whole, minimum_block=3)
    assert {index for index in supported if index >= 32} == {32, 33, 34}
    assert supported[32][0] == pytest.approx(23.0 + shift)

    shifted = speech_windows._shifted_hints(words, hints, whole, heard)

    assert [hint["start"] for hint in shifted] == pytest.approx(
        [float(str(hint["start"])) + shift for hint in hints]
    )
    assert [hint["text"] for hint in shifted] == [hint["text"] for hint in hints]


@pytest.mark.parametrize("entry", [14.9, 15.0])
def test_a_complete_nearby_repeat_can_correct_its_stale_cue(entry):
    lines = [_REFRAIN] * 3
    words = " ".join(lines).split()
    hints = [{"start": start, "text": line} for start, line in zip([10.0, 20.0, 30.0], lines)]
    whole = _timed_lines(lines, [10.0, entry, 30.0])
    heard = [(word.text, word.start, word.end) for word in whole]

    shifted = speech_windows._shifted_hints(words, hints, whole, heard)

    assert [hint["start"] for hint in shifted] == pytest.approx([10.0, entry, 30.0])


def test_a_missed_first_repeat_cannot_claim_the_later_recognized_occurrences():
    lines = [_REFRAIN] * 3
    words = " ".join(lines).split()
    hints = [{"start": start, "text": line} for start, line in zip([10.0, 20.0, 30.0], lines)]
    whole = _timed_lines(lines, [10.0, 20.0, 30.0])
    heard = [(word.text, word.start, word.end) for word in whole[10:]]

    shifted = speech_windows._shifted_hints(words, hints, whole, heard)

    assert shifted == hints


def test_an_incomplete_neighbor_cannot_reserve_the_proposed_recognized_entry():
    words, hints, whole, heard = _internal_motif_case()
    heard = [item for item in heard if item[1] < 20.0 or 23.0 <= item[1] < 24.5]

    shifted = speech_windows._shifted_hints(words, hints, whole, heard)

    assert shifted[-1]["start"] == 23.0


def test_a_common_catalogue_offset_preserves_separate_recognized_occurrences():
    lines = [_REFRAIN] * 5
    cues = [10.0, 20.0, 30.0, 40.0, 50.0]
    hints = [{"start": start, "text": line} for start, line in zip(cues, lines)]
    whole = _timed_lines(lines, [start + 2.5 for start in cues])
    heard = [(word.text, word.start, word.end) for word in whole]

    shifted = speech_windows._shifted_hints(" ".join(lines).split(), hints, whole, heard)

    assert [hint["start"] for hint in shifted] == pytest.approx([start + 2.5 for start in cues])
