"""Cache actual production CREPE observations once, then compare note ownership.

No reference labels are accepted. Pitch is a model estimate, not independent truth.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
from math import isclose
from pathlib import Path
import sys
import time


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def cache_pitch(args, cases):
    import torch
    import torchcrepe
    from backend.ai_worker import pitch

    torch.set_num_threads(1)
    model = Path(torchcrepe.__file__).parent / "assets/full.pth"
    model_sha, code_sha = sha(model), sha(Path(pitch.__file__))
    for case in cases:
        audio = Path(case["audioPath"])
        assert sha(audio) == case["audioSha256"]
        output = args.pitch_dir / (case["case"] + ".json")
        metadata_path = args.pitch_dir / (case["case"] + ".metadata.json")
        if output.exists() or metadata_path.exists():
            previous = json.loads(metadata_path.read_text())
            assert previous["audioSha256"] == case["audioSha256"]
            assert previous["pitchSourceSha256"] == code_sha
            assert previous["crepeModelSha256"] == model_sha
            assert previous["outputSha256"] == sha(output)
            print(json.dumps({"case": case["case"], "reusedVerifiedPitch": True}), flush=True)
            continue
        started = time.perf_counter()
        result = pitch.pitch(audio)
        elapsed = time.perf_counter() - started
        dump(output, result)
        row = {"case": case["case"], "path": str(output), "audioPath": str(audio),
            "audioSha256": sha(audio), "duration": case["duration"], "elapsedSeconds": elapsed,
            "points": len(result["points"]), "outputSha256": sha(output),
            "pitchSourceSha256": code_sha, "crepeModelSha256": model_sha,
            "threads": torch.get_num_threads(),
            "scope": "Actual existing CREPE full through production pitch.pitch; model F0, not manual pitch ground truth."}
        assert row["audioSha256"] == case["audioSha256"]
        dump(metadata_path, row)
        print(json.dumps(row, ensure_ascii=False), flush=True)


def compare_notes(args, cases):
    from backend.ai.domain import PitchPoint, WordTiming
    from backend.lyrics.codec import encode_document, decode_document
    from backend.processing import algorithms as alg

    def owner(doc, moment):
        return next((i for i, w in enumerate(doc.words)
                     if any(n.start <= moment < n.end for n in w.notes)), None)

    def owned_notes(doc):
        return [{"wordIndex": i, "word": w.text, "note": asdict(n)}
                for i, w in enumerate(doc.words) for n in w.notes]

    def identities(rows):
        return {json.dumps(n, ensure_ascii=False, sort_keys=True) for n in rows}

    rows = []
    for case in cases:
        pitch_path = args.pitch_dir / (case["case"] + ".json")
        metadata = json.loads((args.pitch_dir / (case["case"] + ".metadata.json")).read_text())
        assert metadata["audioSha256"] == case["audioSha256"]
        assert metadata["outputSha256"] == sha(pitch_path)
        points = json.loads(pitch_path.read_text())["points"]
        raw = tuple(PitchPoint(p["time"], p["frequency"], p["confidence"], p.get("audioActive")) for p in points)
        stable = alg.stabilize_pitch(raw)
        melody = alg.construct_document("global", "real recording", case["duration"], "а",
            [WordTiming("а", 0, case["duration"], 1)], stable,
            alg.MusicMetadata(None, None)).words[0].notes
        docs, exports = [], []
        for version, directory in (("baseline-v4", args.before_dir), ("final", args.after_dir)):
            payload_path = directory / case["case"] / "payload.json"
            payload = json.loads(payload_path.read_text())["words"]
            words = tuple(WordTiming(w["text"], w["start"], w["end"], w["confidence"],
                tuple(w["letters"]), tuple(w["diagnostics"])) for w in payload)
            doc = alg.construct_document(case["case"], "real recording", case["duration"],
                case["lyrics"], words, stable, alg.MusicMetadata(None, None))
            for word in doc.words:
                expected = [(n.note, max(word.start, n.start), min(word.end, n.end))
                    for n in melody if n.start < word.end and n.end > word.start]
                assert [(n.note, n.start, n.end) for n in word.notes] == expected
            text = encode_document(doc)
            assert decode_document(text) == doc
            target = args.output_dir / case["case"] / version / "lyricsSync.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
            docs.append(doc)
            exports.append({"label": version, "path": str(target), "sha256": sha(target),
                "sourcePayloadSha256": sha(payload_path), "notes": sum(len(w.notes) for w in doc.words),
                "contourPoints": sum(len(n.contour) for w in doc.words for n in w.notes)})
        lost, gained, reassigned = [], [], []
        for point in stable:
            if point.confidence < .5 or point.audio_active is False:
                continue
            old, new = [owner(doc, point.time) for doc in docs]
            datum = {"time": point.time, "frequency": point.frequency, "confidence": point.confidence,
                "beforeOwner": old, "afterOwner": new}
            if old is not None and new is None:
                lost.append(datum)
            elif old is None and new is not None:
                gained.append(datum)
            elif old != new:
                reassigned.append(datum)
        frame_changes = []
        for step in (.01, .005):
            before, after = [list(doc.target_frames(step)) for doc in docs]
            both = [(x, y) for x, y in zip(before, after, strict=True)
                    if x[1] is not None and y[1] is not None]
            changed = [(x, y) for x, y in both if not isclose(x[1], y[1], abs_tol=1e-9)]
            frame_changes.append({"step": step, "commonPitchedFrames": len(both),
                "commonFramePitchDifferences": len(changed),
                "maxPitchDifferenceSemitones": max((abs(x[1] - y[1]) for x, y in changed), default=0.),
                "activityChanges": sum(x[2] != y[2] for x, y in zip(before, after, strict=True))})
        old_notes, new_notes = [identities(owned_notes(doc)) for doc in docs]
        rows.append({"case": case["case"], "pitchPath": str(pitch_path), "pitchSha256": sha(pitch_path),
            "pitchPoints": len(raw), "globalNoteCount": len(melody), "exports": exports,
            "allNotesAreExactGlobalMelodyIntersections": True, "codecRoundTrips": True,
            "commonIdenticalOwnedNotes": len(old_notes & new_notes),
            "removedOrChangedOwnedNotes": [json.loads(n) for n in sorted(old_notes - new_notes)],
            "addedOrChangedOwnedNotes": [json.loads(n) for n in sorted(new_notes - old_notes)],
            "lostStrongPitchPoints": lost, "gainedStrongPitchPoints": gained,
            "reassignedStrongPitchPoints": reassigned, "targetFrames": frame_changes})
        print(json.dumps({"case": case["case"], "notes": [e["notes"] for e in exports],
            "lost": len(lost), "gained": len(gained), "reassigned": len(reassigned)}, ensure_ascii=False), flush=True)
    dump(args.output_dir / "note-comparison.json", {
        "scope": "Production stabilize_pitch/construct_document/_word_with_notes/codec with exact same CREPE observations for both versions. F0 is model-estimated. All clipping, changed ownership, removed notes and changed target frames are retained. No reference label is used to fabricate pitch.",
        "algorithmSourceSha256": sha(Path(alg.__file__)), "inputSha256": sha(args.inputs), "cases": rows})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("cache", "compare"))
    parser.add_argument("--repo-python", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--pitch-dir", type=Path, required=True)
    parser.add_argument("--case", action="append")
    parser.add_argument("--before-dir", type=Path)
    parser.add_argument("--after-dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.repo_python))
    cases = json.loads(args.inputs.read_text())["cases"]
    if args.case:
        assert set(args.case) <= {case["case"] for case in cases}
        cases = [case for case in cases if case["case"] in args.case]
    if args.action == "cache":
        cache_pitch(args, cases)
    else:
        if None in (args.before_dir, args.after_dir, args.output_dir):
            parser.error("compare requires --before-dir, --after-dir, --output-dir")
        compare_notes(args, cases)


if __name__ == "__main__":
    main()
