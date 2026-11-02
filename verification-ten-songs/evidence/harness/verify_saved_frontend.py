"""Exercise actual frontend timing and editor codec for every saved word, without video rendering."""
from pathlib import Path
import argparse
import hashlib
import json
import math
import subprocess

from render_karaoke_selected import font, geometry


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--documents-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(args.inputs.read_text())
    records = []
    face = font(46, True)
    for case in manifest["cases"]:
        case_dir = args.output / case["case"]
        case_dir.mkdir(parents=True, exist_ok=True)
        document = args.documents_root / case["case"] / "final/lyricsSync.json"
        data = json.loads(document.read_text())
        layout_path = case_dir / "layout.private.json"
        samples_path = case_dir / "samples.private.json"
        layout_path.write_text(json.dumps({"schemaVersion": 1, "clipStartSeconds": 0,
            "fps": 60, "frameCount": math.ceil(data["duration"] * 60),
            "words": [{"wordIndex": i, "text": w["text"], "geometry": geometry(w["text"], face)}
                      for i, w in enumerate(data["words"])]}, ensure_ascii=False))
        command = ["node", str(Path(__file__).with_name("sample_frontend.mjs")),
            "--repo", str(args.repo), "--document", str(document),
            "--layout", str(layout_path), "--output", str(samples_path)]
        with (case_dir / "sampler.log").open("w") as log:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
        sampled = json.loads(samples_path.read_text())
        previous = [0.0] * len(data["words"])
        checks = 0
        failures = []
        for frame in sampled["frames"]:
            time = frame["timeSeconds"]
            current = sampled["lines"][frame["activeLineIndex"]] if frame["activeLineIndex"] >= 0 else None
            for row, word in zip(frame["words"], data["words"], strict=True):
                i, progress = row["wordIndex"], row["progress"]
                if not (math.isfinite(progress) and -1e-12 <= progress <= 1 + 1e-12):
                    failures.append({"frame": frame["frame"], "wordIndex": i, "error": "invalid_progress"})
                if progress < previous[i] - 1e-12:
                    failures.append({"frame": frame["frame"], "wordIndex": i, "error": "reverse_progress"})
                if time <= word["start"] and progress != 0:
                    failures.append({"frame": frame["frame"], "wordIndex": i, "error": "premature_fill"})
                if word["start"] + 1e-9 < time < word["end"] - 1e-9:
                    if progress >= 1:
                        failures.append({"frame": frame["frame"], "wordIndex": i, "error": "early_completion"})
                    if current is None or i not in current["wordIndices"] or frame["phase"]["kind"] != "text":
                        failures.append({"frame": frame["frame"], "wordIndex": i, "error": "active_word_hidden"})
                if time >= word["end"] and progress != 1:
                    failures.append({"frame": frame["frame"], "wordIndex": i, "error": "late_completion"})
                previous[i] = progress
                checks += 1
        record = {"case": case["case"], "durationSeconds": data["duration"], "wordCount": len(data["words"]),
            "documentSha256": digest(document), "samplerSha256": sampled["samplerSha256"],
            "sourceHashes": sampled["sourceHashes"], "sourceUnchanged": sampled["sourceUnchanged"],
            "inputsUnchanged": sampled["inputsUnchanged"], "roundTripChecks": sampled["checks"],
            "frames": len(sampled["frames"]), "wordFrameChecks": checks, "failures": failures}
        (case_dir / "verification.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
        records.append(record)
        print(json.dumps({"case": case["case"], "checks": checks, "failures": len(failures)}), flush=True)
    report = {"scope": "Actual unchanged frontend timing sampled at 60 fps across each complete evaluated excerpt, with physical glyph widths; editor roundtrip checked. Not a native app or hardware playback test, and not acoustic ground truth.",
        "inputsSha256": digest(args.inputs), "cases": records,
        "allPassed": all(not row["failures"] for row in records)}
    (args.output / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    if not report["allPassed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
