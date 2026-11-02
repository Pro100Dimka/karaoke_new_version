"""Compare all new held-out words; prediction times never become reference labels."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
from statistics import median


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def error_summary(values):
    values = [abs(v) for v in values]
    return {"count": len(values), "medianAbsMs": median(values) if values else None,
            "maximumAbsMs": max(values, default=None),
            "meanAbsMs": sum(values) / len(values) if values else None}


def invariant_errors(words, duration):
    errors, previous_end = [], 0.0
    for index, word in enumerate(words):
        start, end, letters = word["start"], word["end"], word["letters"]
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= duration + .001):
            errors.append({"index": index, "error": "invalid_word_interval"})
        if start + 1e-9 < previous_end:
            errors.append({"index": index, "error": "overlapping_words"})
        if len(letters) != len(word["text"]):
            errors.append({"index": index, "error": "letter_count"})
        if any(not math.isfinite(t) or t < start - 1e-9 or t > end + 1e-9 for t in letters):
            errors.append({"index": index, "error": "letter_outside_word"})
        if any(a > b for a, b in zip(letters, letters[1:])):
            errors.append({"index": index, "error": "reverse_letter_order"})
        previous_end = end
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--phone-map", type=Path)
    parser.add_argument("--before-dir", type=Path, required=True)
    parser.add_argument("--after-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    cases = json.loads(args.inputs.read_text())["cases"]
    reference = json.loads(args.reference.read_text()) if args.reference else {"cases": []}
    refs = {c["case"]: c for c in reference["cases"]}
    if args.reference:
        assert set(refs) == {c["case"] for c in cases}, "Keep every reference case"
    mapping = json.loads(args.phone_map.read_text()) if args.phone_map else {"words": [], "excludedWords": []}
    if args.phone_map:
        assert args.reference and mapping["referenceSha256"] == digest(args.reference)
    mapped = {(r["case"], r["wordIndex"]): r for r in mapping["words"]}
    rows, phones, sources, case_results = [], [], [], []
    for case in cases:
        predictions = {}
        checks = {}
        for version, directory in (("baseline-v5", args.before_dir), ("final", args.after_dir)):
            path = directory / case["case"] / "payload.json"
            predictions[version] = json.loads(path.read_text())["words"]
            sources.append({"case": case["case"], "version": version, "path": str(path), "sha256": digest(path)})
            checks[version] = invariant_errors(predictions[version], case["duration"])
        expected = case["lyrics"].split()
        assert all([w["text"] for w in p] == expected for p in predictions.values()), case["case"]
        refs_words = refs.get(case["case"], {}).get("words", [])
        if case["case"] in refs:
            assert len(refs_words) == len(expected), "Keep every reference word"
        for index, text in enumerate(expected):
            truth = refs_words[index] if refs_words else None
            if truth:
                assert truth["index"] == index and truth["text"].casefold() == text.casefold()
            row = {"case": case["case"], "wordIndex": index, "text": text,
                   "referenceStart": truth["start"] if truth else None,
                   "referenceEnd": truth["end"] if truth else None,
                   "referenceAccuracyMs": truth.get("referenceAccuracyMs") if truth else None,
                   "referencePhoneQualityFlags": truth.get("phoneQualityFlags", []) if truth else []}
            for version, prediction in predictions.items():
                word = prediction[index]
                row[version] = {**word, "durationMs": round(1000 * (word["end"] - word["start"]), 3),
                    "startErrorMs": round(1000 * (word["start"] - truth["start"]), 3) if truth else None,
                    "endErrorMs": round(1000 * (word["end"] - truth["end"]), 3) if truth else None,
                    "letterDurationsMs": [round(1000 * (b - a), 3) for a, b in
                        zip(word["letters"], [*word["letters"][1:], word["end"]])]}
            row["boundariesChanged"] = any(row["baseline-v5"][k] != row["final"][k] for k in ("start", "end"))
            row["lettersChanged"] = row["baseline-v5"]["letters"] != row["final"]["letters"]
            rows.append(row)
            entry = mapped.get((case["case"], index))
            if entry:
                groups = entry["groups"]
                for group_index, group in enumerate(groups):
                    phone = {"case": case["case"], "wordIndex": index, "word": text,
                             "characters": group["characters"], "indices": group["indices"],
                             "reference": group["reference"], "internalStart": group_index > 0}
                    for version, prediction in predictions.items():
                        word = prediction[index]
                        start = word["letters"][group["indices"][0]]
                        end = word["letters"][groups[group_index + 1]["indices"][0]] if group_index + 1 < len(groups) else word["end"]
                        phone[version] = {"start": start, "end": end,
                            "startErrorMs": round(1000 * (start - group["reference"]["start"]), 3),
                            "endErrorMs": round(1000 * (end - group["reference"]["end"]), 3)}
                    phones.append(phone)
        traces = {}
        for version, directory in (("baseline-v5", args.before_dir), ("final", args.after_dir)):
            path = directory / case["case"]
            stages = json.loads((path / "stages.json").read_text())
            metadata = json.loads((path / "metadata.json").read_text())
            assert metadata.get("completed"), case["case"]
            traces[version] = {"stageCounts": dict(Counter(s["stage"] for s in stages)),
                "mode": metadata["mode"], "tracedElapsedSeconds": metadata["elapsedSeconds"],
                "sourceHashesUnchanged": metadata["sourceHashesUnchanged"],
                "audioHashUnchanged": metadata["audioHashUnchanged"]}
        case_results.append({"case": case["case"], "words": len(expected), "invariantErrors": checks, "traces": traces})
    labelled = [r for r in rows if r["referenceStart"] is not None]
    report = {
        "scope": "All frozen selected words, without outcome-based exclusions. External reference accuracy is unspecified. No reference times passed to inference. Cases without independent labels have null error metrics. Traced timing includes serialization and excludes full-song separation/pitch.",
        "inputSha256": digest(args.inputs), "referenceSha256": digest(args.reference) if args.reference else None,
        "phoneMapSha256": digest(args.phone_map) if args.phone_map else None,
        "sources": sources, "cases": case_results,
        "wordMetrics": {v: {"start": error_summary([r[v]["startErrorMs"] for r in labelled]),
            "end": error_summary([r[v]["endErrorMs"] for r in labelled])} for v in ("baseline-v5", "final")},
        "internalPhoneMetrics": {v: error_summary([r[v]["startErrorMs"] for r in phones if r["internalStart"]]) for v in ("baseline-v5", "final")},
        "boundaryChangedWords": sum(r["boundariesChanged"] for r in rows),
        "letterChangedWords": sum(r["lettersChanged"] for r in rows),
        "rows": rows, "phoneRows": phones, "phoneExcludedWords": mapping["excludedWords"],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("wordMetrics", "internalPhoneMetrics", "boundaryChangedWords", "letterChangedWords")}, indent=2))


if __name__ == "__main__":
    main()
