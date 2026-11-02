from tools.audit_lyrics_sync import audit, lost_notes


def document(text="нья", letters=(0.0, 0.0, 0.5)):
    return {
        "duration": 2,
        "lyrics": text,
        "words": [{"text": text, "start": 0, "end": 1, "letters": letters, "notes": []}],
    }


def test_silent_character_does_not_collapse_preceding_sounding_group():
    result = audit(document())
    assert "ZeroSoundingLetterCandidate" not in result["summary"]["diagnostics"]
    assert result["words"][0]["letters"][0]["end"] == 0


def test_genuinely_zero_sounding_group_remains_a_candidate():
    result = audit(document(letters=(0.0, 0.0, 0.0)))
    assert result["summary"]["diagnostics"]["ZeroSoundingLetterCandidate"] == 1


def test_zero_support_occurrence_list_is_preserved():
    result = audit(document(), report={"warnings": ["AlignmentApproximate:wordIndices=0"]})
    assert "AlignmentApproximate" in result["words"][0]["uncertainty"]


def test_phrase_warning_applies_to_half_open_range_only():
    doc = document("а", (0.0,))
    doc["duration"] = 4
    doc["lyrics"] = "а а а"
    doc["words"] = [dict(doc["words"][0], start=i, end=i + 1, letters=[i]) for i in range(3)]
    warning = "AlignmentRateReview:wordRange=0-2;lettersPerSecond=99.00"
    result = audit(doc, report={"warnings": [warning]})
    assert [warning in row["uncertainty"] for row in result["words"]] == [True, True, False]


def test_split_note_preserves_absolute_midi_coverage():
    before = {"words": [{"notes": [{"note": 60, "start": 0, "end": 1}]}]}
    after = {
        "words": [
            {"notes": [{"note": 60, "start": 0, "end": 0.5}]},
            {"notes": [{"note": 60, "start": 0.5, "end": 1}]},
        ]
    }
    assert lost_notes(before, after) == []


def test_note_comparison_discloses_contour_and_ownership_limitations():
    doc = document()
    caveat = audit(doc, before=doc)["summary"]["noteComparisonCaveat"]
    assert "contour" in caveat
    assert "ownership" in caveat
