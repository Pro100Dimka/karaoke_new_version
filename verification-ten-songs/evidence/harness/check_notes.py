"""Cache actual production CREPE observations once, then compare note ownership.

No reference labels are accepted. Pitch is a model estimate, not independent truth.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, replace
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


def music_for_case(args, case):
    """Reuse Demucs rhythm; compute the production PCM music estimate once."""
    from backend.infrastructure import wave_music_analyzer
    from backend.processing.algorithms import MusicMetadata

    mix = Path(case["mixPath"])
    assert sha(mix) == case["mixSha256"]
    state_path = (args.preflight_root / case["case"] / "metadata.json" if args.preflight_root
                  else Path(case["audioPath"]).parent.parent / "metadata.json")
    state = json.loads(state_path.read_text())
    assert state["case"] == case["case"] and state["completed"]
    assert state["inputs"]["audioSha256"] == case["mixSha256"]
    assert state["vocalSha256"] == case["audioSha256"]
    assert state["instrumentalSha256"] == case["instrumentalSha256"]
    identity = {"case": case["case"], "durationSeconds": case["duration"],
        "mixPath": str(mix), "mixSha256": case["mixSha256"],
        "preflightMetadataPath": str(state_path), "preflightMetadataSha256": sha(state_path),
        "musicAnalyzerSourceSha256": sha(Path(wave_music_analyzer.__file__)),
        "separationSourceSha256": state["sourceHashes"]["backend/ai_worker/separation.py"]}
    output = (args.music_dir or args.pitch_dir / "music") / (case["case"] + ".json")
    if output.exists():
        record = json.loads(output.read_text())
        assert record["identity"] == identity, f"Changed music cache inputs: {case['case']}"
        assert record["rhythm"] == state["stems"]["rhythm"]
    else:
        started = time.perf_counter()
        music = wave_music_analyzer.WaveMusicAnalyzer().analyze(mix)
        record = {"identity": identity, "music": asdict(music),
            "rhythm": state["stems"]["rhythm"],
            "elapsedSeconds": time.perf_counter() - started,
            "scope": "Production WaveMusicAnalyzer on the unchanged bounded source mix; BPM is an excerpt estimate, not full-song tempo truth. Rhythm is copied exactly from the already completed production Demucs separation. No fresh model or separation."}
        assert sha(mix) == case["mixSha256"] and sha(state_path) == identity["preflightMetadataSha256"]
        dump(output, record)
    music = MusicMetadata(**record["music"])
    rhythm = tuple((float(moment), float(strength)) for moment, strength in record["rhythm"])
    return music, rhythm, {"path": str(output), "sha256": sha(output),
        "bpm": music.bpm, "key": music.key, "rhythmPoints": len(rhythm),
        "calculationSeconds": record["elapsedSeconds"]}


def cache_pitch(args, cases):
    import torch
    import torchcrepe
    from backend.ai_worker import pitch
    from backend.ai_worker.runtime import cpu_threads

    torch.set_num_threads(args.threads if args.threads is not None else cpu_threads())
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
            "threads": torch.get_num_threads(), "requestedThreads": args.threads,
            "scope": "Actual existing CREPE full through production pitch.pitch; model F0, not manual pitch ground truth."}
        assert row["audioSha256"] == case["audioSha256"]
        dump(metadata_path, row)
        print(json.dumps(row, ensure_ascii=False), flush=True)


def compare_notes(args, cases):
    from backend.ai.domain import PitchPoint, WordTiming
    from backend.lyrics.codec import encode_document, decode_document
    from backend.processing import algorithms as alg
    from backend.processing.reporting import alignment_warnings, pitch_warnings

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
        music, rhythm, music_cache = music_for_case(args, case)
        pitch_path = args.pitch_dir / (case["case"] + ".json")
        metadata = json.loads((args.pitch_dir / (case["case"] + ".metadata.json")).read_text())
        assert metadata["audioSha256"] == case["audioSha256"]
        assert metadata["outputSha256"] == sha(pitch_path)
        points = json.loads(pitch_path.read_text())["points"]
        raw = tuple(PitchPoint(p["time"], p["frequency"], p["confidence"], p.get("audioActive")) for p in points)
        stable = alg.stabilize_pitch(raw)
        melody = alg.construct_document("global", "real recording", case["duration"], "а",
            [WordTiming("а", 0, case["duration"], 1)], stable,
            music).words[0].notes
        docs, exports = [], []
        for version, directory in ((args.before_label, args.before_dir), ("final", args.after_dir)):
            payload_path = directory / case["case"] / "payload.json"
            payload = json.loads(payload_path.read_text())["words"]
            words = tuple(WordTiming(w["text"], w["start"], w["end"], w["confidence"],
                tuple(w["letters"]), tuple(w["diagnostics"])) for w in payload)
            doc = alg.construct_document(case["title"], case["artist"], case["duration"],
                case["lyrics"], words, stable, music)
            doc = replace(doc, rhythm=rhythm)
            assert [(w.text, w.start, w.end, w.letters) for w in doc.words] == [
                (w.text, w.start, w.end, w.letters) for w in words]
            for word in doc.words:
                expected = [(n.note, max(word.start, n.start), min(word.end, n.end))
                    for n in melody if n.start < word.end and n.end > word.start]
                assert [(n.note, n.start, n.end) for n in word.notes] == expected
            text = encode_document(doc)
            assert decode_document(text) == doc
            target = args.output_dir / case["case"] / version / "lyricsSync.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
            audit_path = target.with_name("processing-audit.json")
            dump(audit_path, {"case": case["case"], "version": version,
                "scope": "Production alignment_warnings and pitch_warnings for a frozen excerpt transcript. This is not a catalogue discovery/import report or independent timing ground truth. Codec intentionally leaves these diagnostics outside lyricsSync.json.",
                "documentPath": str(target), "documentSha256": sha(target),
                "sourcePayloadSha256": sha(payload_path), "sourcePitchSha256": sha(pitch_path),
                "musicCache": music_cache, "lyricsSourceText": case["lyrics"],
                "persistedPhraseText": doc.lyrics,
                "warnings": list(alignment_warnings(words, lyrics=case["lyrics"], bpm=music.bpm)
                                 + pitch_warnings(stable)),
                "wordDiagnostics": [{"wordIndex": i, "text": w.text, "confidence": w.confidence,
                    "diagnostics": list(w.diagnostics)} for i, w in enumerate(words)]})
            docs.append(doc)
            exports.append({"label": version, "path": str(target), "sha256": sha(target),
                "sourcePayloadSha256": sha(payload_path), "notes": sum(len(w.notes) for w in doc.words),
                "contourPoints": sum(len(n.contour) for w in doc.words for n in w.notes),
                "processingAuditPath": str(audit_path), "processingAuditSha256": sha(audit_path)})
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
            "musicCache": music_cache,
            "allNotesAreExactGlobalMelodyIntersections": True, "codecRoundTrips": True,
            "commonIdenticalOwnedNotes": len(old_notes & new_notes),
            "removedOrChangedOwnedNotes": [json.loads(n) for n in sorted(old_notes - new_notes)],
            "addedOrChangedOwnedNotes": [json.loads(n) for n in sorted(new_notes - old_notes)],
            "lostStrongPitchPoints": lost, "gainedStrongPitchPoints": gained,
            "reassignedStrongPitchPoints": reassigned, "targetFrames": frame_changes})
        print(json.dumps({"case": case["case"], "notes": [e["notes"] for e in exports],
            "lost": len(lost), "gained": len(gained), "reassigned": len(reassigned)}, ensure_ascii=False), flush=True)
    dump(args.output_dir / "note-comparison.json", {
        "scope": "Production stabilize_pitch/construct_document/_word_with_notes/codec with exact same CREPE observations and source-mix music metadata/rhythm for both versions. F0 and excerpt BPM are model/algorithm estimates. All clipping, changed ownership, removed notes and changed target frames are retained. No reference label is used to fabricate pitch.",
        "algorithmSourceSha256": sha(Path(alg.__file__)), "inputSha256": sha(args.inputs), "cases": rows})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("cache", "cache-music", "compare"))
    parser.add_argument("--repo-python", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--pitch-dir", type=Path, required=True)
    parser.add_argument("--threads", type=int, help="CREPE cache only: Torch CPU threads; default is production cpu_threads()")
    parser.add_argument("--music-dir", type=Path)
    parser.add_argument("--preflight-root", type=Path)
    parser.add_argument("--case", action="append")
    parser.add_argument("--before-dir", type=Path)
    parser.add_argument("--before-label", default="baseline-v5")
    parser.add_argument("--after-dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if args.threads is not None and (args.action != "cache" or args.threads < 1):
        parser.error("--threads requires cache and a positive integer")
    sys.path.insert(0, str(args.repo_python))
    cases = json.loads(args.inputs.read_text())["cases"]
    if args.case:
        assert set(args.case) <= {case["case"] for case in cases}
        cases = [case for case in cases if case["case"] in args.case]
    if args.action == "cache":
        cache_pitch(args, cases)
    elif args.action == "cache-music":
        for case in cases:
            _, _, record = music_for_case(args, case)
            print(json.dumps({"case": case["case"], **record}, ensure_ascii=False), flush=True)
    else:
        if None in (args.before_dir, args.after_dir, args.output_dir):
            parser.error("compare requires --before-dir, --after-dir, --output-dir")
        compare_notes(args, cases)


if __name__ == "__main__":
    main()
