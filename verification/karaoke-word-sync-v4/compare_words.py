"""Compare unchanged frozen external labels against v3 and v4 payloads.

No reference times are passed to the alignment code. Signed errors are
prediction minus published reference; source annotation uncertainty is unknown.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from statistics import median


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metrics(rows: list[dict], version: str) -> dict:
    starts = [abs(row[version]["startErrorMs"]) for row in rows]
    ends = [abs(row[version]["endErrorMs"]) for row in rows]
    return {
        "words": len(rows),
        "medianAbsoluteStartErrorMs": median(starts),
        "maximumAbsoluteStartErrorMs": max(starts),
        "meanAbsoluteStartErrorMs": sum(starts) / len(starts),
        "medianAbsoluteEndErrorMs": median(ends),
        "maximumAbsoluteEndErrorMs": max(ends),
        "meanAbsoluteEndErrorMs": sum(ends) / len(ends),
        "medianAbsoluteBoundaryErrorMs": median(starts + ends),
        "maximumAbsoluteBoundaryErrorMs": max(starts + ends),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/tmp/karaoke-sync-v4"))
    parser.add_argument("--after", default="gtsinger-final")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows, sources = [], []
    for subset, name in (("primary", "frozen-reference.json"),
                         ("additional", "frozen-additional-reference.json")):
        reference = args.root / "audio-reference" / name
        sources.append({"reference": str(reference), "sha256": digest(reference)})
        for case in json.loads(reference.read_text())["cases"]:
            paths = {"v3": args.root / "gtsinger-baseline" / case["case"] / "payload.json",
                     "v4": args.root / args.after / case["case"] / "payload.json"}
            predictions = {version: json.loads(path.read_text())["words"]
                           for version, path in paths.items()}
            assert all(len(value) == len(case["words"]) for value in predictions.values())
            sources.extend({"version": version, "path": str(path), "sha256": digest(path)}
                           for version, path in paths.items())
            for word in case["words"]:
                row = {"subset": subset, "case": case["case"], "wordIndex": word["index"],
                       "text": word["text"], "referenceStart": word["start"],
                       "referenceEnd": word["end"], "referenceAccuracyMs": None,
                       "referencePhoneEligible": word["phoneMetricEligible"]}
                for version, prediction in predictions.items():
                    actual = prediction[word["index"]]
                    assert actual["text"].casefold() == word["text"].casefold()
                    row[version] = {
                        **actual,
                        "durationMs": round((actual["end"] - actual["start"]) * 1000, 3),
                        "startErrorMs": round((actual["start"] - word["start"]) * 1000, 3),
                        "endErrorMs": round((actual["end"] - word["end"]) * 1000, 3),
                        "letterDurationsMs": [round((b - a) * 1000, 3) for a, b in
                            zip(actual["letters"], [*actual["letters"][1:], actual["end"]])],
                    }
                row["boundariesChanged"] = any(row["v3"][key] != row["v4"][key]
                                               for key in ("start", "end"))
                row["lettersChanged"] = row["v3"]["letters"] != row["v4"]["letters"]
                rows.append(row)
    report = {
        "scope": "Published GTSinger authors' listening/spectrogram-corrected labels; not our own listening. Frozen before inference; not inputs to prediction. Reference uncertainty is unspecified and known imperfect endpoints remain in the raw metrics.",
        "sources": sources,
        "metrics": {subset: {version: metrics(selection, version) for version in ("v3", "v4")}
                    for subset in ("primary", "additional", "all")
                    if (selection := [row for row in rows if subset == "all" or row["subset"] == subset])},
        "boundaryChangedWords": sum(row["boundariesChanged"] for row in rows),
        "letterChangedWords": sum(row["lettersChanged"] for row in rows),
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report["metrics"], indent=2))
    for row in rows:
        if row["boundariesChanged"]:
            print(row["case"], row["text"],
                  [(row[v]["start"], row[v]["end"], row[v]["startErrorMs"], row[v]["endErrorMs"])
                   for v in ("v3", "v4")])


if __name__ == "__main__":
    main()
