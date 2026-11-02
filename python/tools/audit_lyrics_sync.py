"""Audit every saved word, letter, line and note; accuracy requires independent labels.

Example: python tools/audit_lyrics_sync.py lyricsSync.json --output audit --before old.json
Optional reference JSON: {"independent": true, "source": "...", "words":
[{"index": 0, "text": "...", "start": 1.0, "end": 1.5}]}.
Indices are occurrence-specific; mismatched text is rejected, never fuzzily matched.
"""

from __future__ import annotations

import argparse
from collections import Counter
import csv
import hashlib
import json
import math
from pathlib import Path
import re
from statistics import median
import unicodedata


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig")) if path else None


def lost_notes(before, after):
    """Compare absolute melody coverage, allowing a note to split between words."""
    current = [note for word in after["words"] for note in word.get("notes", [])]
    lost = []
    for index, word in enumerate(before["words"]):
        for note in word.get("notes", []):
            remaining = [(note["start"], note["end"])]
            for other in current:
                if other["note"] != note["note"]:
                    continue
                remaining = [
                    (a, b)
                    for left, right in remaining
                    for a, b in [
                        (left, min(right, other["start"])),
                        (max(left, other["end"]), right),
                    ]
                    if b - a > 1e-9
                ]
            if remaining:
                lost.append(dict(wordIndex=index, note=note["note"], intervals=remaining))
    return lost


def audit(document, *, before=None, reference=None, report=None, pitch=None):
    words = document["words"]
    prior = before["words"] if before else []
    comparable = bool(before) and [w["text"] for w in prior] == [w["text"] for w in words]
    truth = {}
    if reference is not None:
        if reference.get("independent") is not True or not reference.get("source"):
            raise ValueError("Accuracy requires an explicitly independent, attributed reference")
        for word in reference["words"]:
            index = word["index"]
            if (
                index in truth
                or not 0 <= index < len(words)
                or words[index]["text"] != word["text"]
            ):
                raise ValueError("Reference indices/text do not match this occurrence sequence")
            if not 0 <= word["start"] < word["end"] <= document["duration"]:
                raise ValueError("Reference interval is invalid")
            truth[index] = word
    flags = {}
    for warning in (report or {}).get("warnings", []):
        match = re.search(r"wordIndex=(\d+);(.*)", warning)
        if match:
            flags.setdefault(int(match[1]), []).append(match[2])
        listed = re.search(r"^AlignmentApproximate:wordIndices=(\d+(?:,\d+)*)$", warning)
        if listed:
            for index in map(int, listed[1].split(",")):
                if index < len(words):
                    flags.setdefault(index, []).append("AlignmentApproximate")
        ranged = re.search(r"wordRange=(\d+)-(\d+);", warning)
        if ranged:
            for index in range(int(ranged[1]), min(int(ranged[2]), len(words))):
                flags.setdefault(index, []).append(warning)
    written = document.get("lyrics", "").splitlines()
    line_map = [
        (line, local) for line, text in enumerate(written) for local, _ in enumerate(text.split())
    ]
    lines_match = document.get("lyrics", "").split() == [w["text"] for w in words]
    rows, errors, before_errors = [], [], []
    for index, word in enumerate(words):
        start, end = word["start"], word["end"]
        letters, notes = word.get("letters", []), word.get("notes", [])
        diagnostics = []
        if (
            not all(math.isfinite(t) for t in (start, end))
            or not 0 <= start < end <= document["duration"]
        ):
            diagnostics.append("InvalidWordInterval")
        if index and words[index - 1]["end"] > start + 1e-9:
            diagnostics.append("NeighbourOverlap")
        if letters and len(letters) != len(word["text"]):
            diagnostics.append("LetterCountMismatch")
        spans = []
        for letter, (left, right) in enumerate(zip(letters, [*letters[1:], end])):
            char = word["text"][letter] if letter < len(word["text"]) else ""
            spans.append(dict(index=letter, char=char, start=left, end=right))
            if not start <= left <= right <= end:
                diagnostics.append("InvalidLetterInterval")
        # Match frontend spokenIndices: silent characters share the preceding sound.
        sounding = [
            i
            for i, char in enumerate(word["text"])
            if i < len(letters)
            and not char.isspace()
            and not unicodedata.category(char).startswith("M")
            and char.casefold() not in ".,!?;:'’ʼ‘\"()-–—…«»„“”ьъ"
        ]
        if any(
            letters[left] == (letters[right] if right < len(letters) else end)
            for left, right in zip(sounding, [*sounding[1:], len(letters)])
        ):
            diagnostics.append("ZeroSoundingLetterCandidate")
        if 0 < end - start < 0.08:
            diagnostics.append("ShortWordCandidate")
        if end - start > 2:
            diagnostics.append("LongWordCandidate")
        for position, note in enumerate(notes):
            if not start <= note["start"] < note["end"] <= end:
                diagnostics.append("NoteOutsideWord")
            if position and notes[position - 1]["end"] > note["start"] + 1e-9:
                diagnostics.append("NoteOverlap")
            contour = note.get("contour", [])
            if any(
                not 0 <= t <= 1 or not math.isfinite(offset) or not 0 <= conf <= 1
                for t, offset, conf in contour
            ):
                diagnostics.append("InvalidNoteContour")
            if any(b[0] <= a[0] for a, b in zip(contour, contour[1:])):
                diagnostics.append("UnorderedNoteContour")
        expected = truth.get(index)
        error = (
            [abs(word[key] - expected[key]) * 1000 for key in ("start", "end")]
            if expected
            else None
        )
        old = prior[index] if comparable else None
        old_error = (
            [abs(old[key] - expected[key]) * 1000 for key in ("start", "end")]
            if expected and old
            else None
        )
        errors.extend(error or [])
        before_errors.extend(old_error or [])
        rows.append(
            dict(
                song=document.get("title"),
                artist=document.get("artist"),
                index=index,
                lineIndex=line_map[index][0] if lines_match else None,
                wordIndex=line_map[index][1] if lines_match else None,
                text=word["text"],
                start=start,
                end=end,
                duration=end - start,
                letters=spans,
                notes=notes,
                uncertainty=list(
                    dict.fromkeys([*word.get("diagnostics", []), *flags.get(index, [])])
                ),
                diagnostics=list(dict.fromkeys(diagnostics)),
                before=old,
                after=word,
                reference=expected,
                boundaryErrorMs=error,
                beforeBoundaryErrorMs=old_error,
            )
        )
    summary = dict(
        words=len(words),
        letters=sum(len(r["letters"]) for r in rows),
        notes=sum(len(r["notes"]) for r in rows),
        lines=len(written),
        writtenLinesMatch=lines_match,
        beforeComparable=comparable,
        diagnostics=dict(Counter(flag for row in rows for flag in row["diagnostics"])),
        uncertaintyAvailable=report is not None or any("diagnostics" in w for w in words),
        approximateLetterWords=sum("ApproximateLetterTiming" in row["uncertainty"] for row in rows),
        changedWords=sum(row["before"] != row["after"] for row in rows) if comparable else None,
        accuracy=None,
        screening="Short/long/zero intervals are review candidates, not proven acoustic errors.",
    )
    if errors:
        summary["accuracy"] = dict(
            source=reference["source"],
            boundaries=len(errors),
            medianMs=median(errors),
            p95Ms=sorted(errors)[math.ceil(0.95 * len(errors)) - 1],
            maxMs=max(errors),
            overMs={str(t): sum(e > t for e in errors) for t in (50, 100, 200, 500)},
            improvedBoundaries=sum(a < b - 1e-6 for a, b in zip(errors, before_errors))
            if comparable
            else None,
            regressedBoundaries=sum(a > b + 1e-6 for a, b in zip(errors, before_errors))
            if comparable
            else None,
        )
    if before:
        missing = lost_notes(before, document)
        summary["changedOrUnassignedPriorNotes"] = missing
        summary["noteComparisonCaveat"] = (
            "Changed pitch or missing coverage is diagnostic, not proven acoustic loss. "
            "This coverage comparison does not verify contour preservation or word ownership."
        )
    if pitch is not None:
        points = pitch["points"]
        notes = [note for word in words for note in word.get("notes", [])]
        unassigned = [
            p
            for p in points
            if p["confidence"] >= 0.5
            and p["frequency"] > 0
            and p.get("audioActive") is not False
            and not any(n["start"] <= p["time"] < n["end"] for n in notes)
        ]
        summary["unassignedConfidentPitchPoints"] = unassigned
        summary["pitchCaveat"] = "Model confidence is not an independent pitch reference."
    lines = [
        dict(
            index=i,
            start=min(w["start"] for w in words[first:last]),
            end=max(w["end"] for w in words[first:last]),
        )
        for i in range(len(written))
        for indices in [[j for j, pair in enumerate(line_map) if pair[0] == i]]
        if lines_match and indices
        for first, last in [(indices[0], indices[-1] + 1)]
    ]
    return dict(summary=summary, words=rows, lines=lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", type=Path)
    for name in ("before", "reference", "report", "pitch"):
        parser.add_argument("--" + name, type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(
        read(args.document),
        before=read(args.before),
        reference=read(args.reference),
        report=read(args.report),
        pitch=read(args.pitch),
    )
    result["documentSha256"] = hashlib.sha256(args.document.read_bytes()).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.with_suffix(".json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    with args.output.with_suffix(".csv").open("w", encoding="utf-8-sig", newline="") as stream:
        fields = list(result["words"][0]) if result["words"] else ["index", "text"]
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(
            {
                key: json.dumps(value, ensure_ascii=False)
                if isinstance(value, (list, dict))
                else value
                for key, value in row.items()
            }
            for row in result["words"]
        )
    print(json.dumps(result["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
