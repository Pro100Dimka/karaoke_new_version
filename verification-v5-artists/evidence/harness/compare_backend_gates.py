"""Compare completed backend gates without treating old failures as new regressions."""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re


def load(directory: Path):
    result = json.loads((directory / "result.json").read_text())
    summary = json.loads((directory / "summary.json").read_text())
    if not result.get("pytestCompleted") or not result.get("sourceUnchanged"):
        raise ValueError(f"Not a completed immutable test run: {directory}")
    return result, summary


def architecture(directory: Path):
    entries = {}
    for line in (directory / "architecture.log").read_text().splitlines():
        if not line.startswith("ERROR: "):
            continue
        identity = re.sub(r":\d+: ", ":LINE: ", line)
        identity = re.sub(r"\b\d+ lines", "N lines", identity)
        identity = re.sub(r"complexity proxy \d+", "complexity proxy N", identity)
        entries[identity] = line
    return entries


def mypy(directory: Path):
    return Counter(
        re.sub(r":\d+: error:", ":LINE: error:", line)
        for line in (directory / "mypy.log").read_text().splitlines()
        if ": error:" in line
    )


def formatting(directory: Path):
    log = (directory / "format.log").read_text()
    return set(re.findall(r"(?:-->\s+|Would reformat:\s+)([^\s:]+\.py)", log))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    (old, old_meta), (new, new_meta) = load(args.before), load(args.after)
    for key in ("python", "platform", "environment", "versions"):
        if old_meta[key] != new_meta[key]:
            raise ValueError(f"Gate environment differs: {key}")
    old_ids, new_ids = set(old["failureIDs"]), set(new["failureIDs"])
    before_arch, after_arch = architecture(args.before), architecture(args.after)
    before_mypy, after_mypy = mypy(args.before), mypy(args.after)
    before_format, after_format = formatting(args.before), formatting(args.after)
    old_hashes, new_hashes = old_meta["sourceHashesBefore"], new_meta["sourceHashesBefore"]
    report = {
        "scope": "Completed full backend runs in the same runtime/environment. Continued failed constituents remain failed. Gate wall time is not a performance benchmark. Architecture line numbers and changing sizes of already-oversized code do not create false new identities; their before/after messages remain visible.",
        "before": str(args.before.resolve()), "after": str(args.after.resolve()),
        "pytestBefore": old["pytestSummary"], "pytestAfter": new["pytestSummary"],
        "newFailureIDs": sorted(new_ids - old_ids),
        "resolvedFailureIDs": sorted(old_ids - new_ids),
        "remainingFailureIDs": sorted(old_ids & new_ids),
        "failureCountsByFile": {
            label: dict(sorted(Counter(value.split("::", 1)[0] for value in ids).items()))
            for label, ids in (("baseline-v4", old_ids), ("final", new_ids))
        },
        "newErrorIDs": sorted(set(new["errorIDs"]) - set(old["errorIDs"])),
        "gateExitCodes": {
            name: {"baseline-v4": check["exitCode"], "final": new["checks"][name]["exitCode"]}
            for name, check in old["checks"].items()
        },
        "architecture": {
            "newFindings": [after_arch[key] for key in sorted(after_arch.keys() - before_arch.keys())],
            "resolvedFindings": [before_arch[key] for key in sorted(before_arch.keys() - after_arch.keys())],
            "changedExistingMessages": [
                {"before": before_arch[key], "after": after_arch[key]}
                for key in sorted(before_arch.keys() & after_arch.keys())
                if before_arch[key] != after_arch[key]
            ],
        },
        "format": {"newFiles": sorted(after_format - before_format),
                   "resolvedFiles": sorted(before_format - after_format)},
        "mypy": {"newErrors": list((after_mypy - before_mypy).elements()),
                 "resolvedErrors": list((before_mypy - after_mypy).elements())},
        "changedPythonFiles": sorted(key for key in old_hashes.keys() | new_hashes.keys()
                                     if old_hashes.get(key) != new_hashes.get(key)),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ("pytestBefore", "pytestAfter", "newFailureIDs", "newErrorIDs")}, indent=2))


if __name__ == "__main__":
    main()
