"""Audit actual CREPE point ownership against frozen external word intervals.

Published word intervals are the reference. CREPE frequency/confidence are model
observations, not manual F0 truth. Neither source is changed by this evaluator.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
from statistics import median
import sys


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit_points(points, document, word_index):
    counts = Counter(correctWord=0, wrongWord=0, missingNote=0)
    missing_reasons, wrong_owners = Counter(), Counter()
    details = []
    for point in points:
        moment = point["time"]
        owners = [i for i, word in enumerate(document.words)
                  if any(note.start <= moment < note.end for note in word.notes)]
        assert len(owners) <= 1, "Overlapping note ownership in final document"
        owner = owners[0] if owners else None
        reason = None
        if owner == word_index:
            status = "correctWord"
        elif owner is not None:
            status = "wrongWord"
            wrong_owners[f"{owner}:{document.words[owner].text}"] += 1
        else:
            status = "missingNote"
            word_owners = [i for i, word in enumerate(document.words)
                           if word.start <= moment < word.end]
            if word_index in word_owners:
                reason = "inside_correct_predicted_word_but_no_note"
            elif word_owners:
                reason = "inside_other_predicted_word_but_no_note"
            else:
                reason = "outside_all_predicted_words"
            missing_reasons[reason] += 1
        counts[status] += 1
        details.append({"time": moment, "frequency": point["frequency"],
            "confidence": point["confidence"], "classification": status,
            "assignedWordIndex": owner,
            "assignedWord": document.words[owner].text if owner is not None else None,
            "missingReason": reason})
    return {"eligiblePoints": len(points), **dict(counts),
            "wrongWordOwners": dict(wrong_owners), "missingReasons": dict(missing_reasons),
            "points": details}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-python", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--pitch-dir", type=Path, required=True)
    parser.add_argument("--documents-dir", type=Path, required=True)
    parser.add_argument("--before-dir", type=Path, required=True)
    parser.add_argument("--after-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", action="append")
    args = parser.parse_args()
    sys.path.insert(0, str(args.repo_python))
    from backend.lyrics.codec import decode_document, encode_document

    reference = json.loads(args.reference.read_text())
    all_cases = reference["cases"]
    if args.case:
        assert set(args.case) <= {case["case"] for case in all_cases}
    cases = [case for case in all_cases if not args.case or case["case"] in args.case]
    assert cases
    rows, sources, transformations = [], [], []
    for case in cases:
        pitch_path = args.pitch_dir / (case["case"] + ".json")
        metadata_path = args.pitch_dir / (case["case"] + ".metadata.json")
        metadata = json.loads(metadata_path.read_text())
        assert metadata["audioSha256"] == case["audioSha256"]
        assert metadata["outputSha256"] == sha(pitch_path)
        points = json.loads(pitch_path.read_text())["points"]
        differences = [b["time"] - a["time"] for a, b in zip(points, points[1:])]
        hop = median(differences) if differences else None
        eligible = [point for point in points if point["confidence"] >= .5
                    and point.get("audioActive") is True and point["frequency"] > 0]
        docs = {}
        for version, payload_dir in (("baseline-v4", args.before_dir), ("final", args.after_dir)):
            document_path = args.documents_dir / case["case"] / version / "lyricsSync.json"
            payload_path = payload_dir / case["case"] / "payload.json"
            doc = decode_document(document_path.read_text())
            assert decode_document(encode_document(doc)) == doc
            payload = json.loads(payload_path.read_text())["words"]
            assert len(doc.words) == len(payload) == len(case["words"])
            fields = ("text", "start", "end", "letters")
            preserved = all(all(getattr(word, key) == (tuple(raw[key]) if key == "letters" else raw[key])
                                for key in fields) for word, raw in zip(doc.words, payload))
            transformations.append({"case": case["case"], "version": version,
                "wordAndLetterFieldsExactlyPreserved": preserved, "codecRoundTripEqual": True,
                "payloadSha256": sha(payload_path), "documentSha256": sha(document_path)})
            assert preserved, f"Final normalization/codec changed words or letters: {case['case']} {version}"
            docs[version] = doc
        sources.append({"case": case["case"], "pitchPath": str(pitch_path),
            "pitchSha256": sha(pitch_path), "audioSha256": case["audioSha256"],
            "pitchFrameStepSeconds": hop, "allPitchPoints": len(points),
            "highConfidenceActivePitchPoints": len(eligible)})
        for word in case["words"]:
            index, start, end = word["index"], word["start"], word["end"]
            assert all(doc.words[index].text.casefold() == word["text"].casefold() for doc in docs.values())
            selection = [point for point in eligible if start <= point["time"] < end]
            core = [point for point in selection if start + .02 <= point["time"] < end - .02]
            result = {"case": case["case"], "wordIndex": index, "word": word["text"],
                "referenceStart": start, "referenceEnd": end,
                "referenceAccuracyMs": word.get("referenceAccuracyMs"),
                "referencePhoneQualityFlags": word.get("phoneQualityFlags", []),
                "referenceWindowConvention": "start inclusive; end exclusive",
                "pitchFrameStepSeconds": hop,
                "coreMarginSeconds": .02,
                "coreExplanation": "Additional sensitivity check excluding 20ms from both external word edges; full-window results are always retained."}
            for version, doc in docs.items():
                result[version] = {"predictedStart": doc.words[index].start,
                    "predictedEnd": doc.words[index].end,
                    "fullReferenceWindow": audit_points(selection, doc, index),
                    "referenceCore": audit_points(core, doc, index)}
            rows.append(result)
    totals = {}
    for version in ("baseline-v4", "final"):
        totals[version] = {window: {key: sum(row[version][window][key] for row in rows)
            for key in ("eligiblePoints", "correctWord", "wrongWord", "missingNote")}
            for window in ("fullReferenceWindow", "referenceCore")}
    report = {
        "scope": "All words from explicitly selected cases with actual cached CREPE points. Frozen author word labels define ownership; frequency/confidence remain model estimates, not manually confirmed F0. Missing/incorrect ownership is retained even when baseline v4 and final are identical. A point count times the 10ms hop is an approximate amount of covered grid, not an independently measured phonation duration.",
        "referenceSha256": sha(args.reference),
        "selection": [case["case"] for case in cases],
        "unselectedCases": [case["case"] for case in all_cases if case not in cases],
        "sources": sources, "payloadToFinalDocumentChecks": transformations,
        "totals": totals, "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(totals, ensure_ascii=False, indent=2))
    for row in rows:
        current = row["final"]["fullReferenceWindow"]
        if current["wrongWord"] or current["missingNote"]:
            print(row["case"], row["word"], "correct/wrong/missing",
                  current["correctWord"], current["wrongWord"], current["missingNote"],
                  "missingReasons", current["missingReasons"])


if __name__ == "__main__":
    main()
