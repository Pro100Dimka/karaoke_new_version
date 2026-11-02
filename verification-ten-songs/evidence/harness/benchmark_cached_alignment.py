"""Time production speech.align on frozen evidence, without tracing, I/O or models.

ASR/MMS, decoded waveforms and the model-assisted singing mask are reused from
run_alignment.py. Other DSP, CTC search, local review and final payload creation
run normally. This measures cached alignment, not full-song processing.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import ExitStack
from datetime import datetime, timezone
from functools import wraps
from hashlib import sha256
import inspect
import json
import os
from pathlib import Path
import statistics
import sys
import time
import traceback
from unittest.mock import patch


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def sha(path):
    return sha256(path.read_bytes()).hexdigest()


def frozen(value):
    if isinstance(value, dict):
        return tuple((key, frozen(item)) for key, item in sorted(value.items()))
    if isinstance(value, (list, tuple)):
        return tuple(frozen(item) for item in value)
    return value


class StrictCachedRecognition:
    """The trace's exact request identity, compiled before any timed execution."""

    def __init__(self, records, array_sources=(), path_sources=()):
        self.arrays = {id(array): (array, frozen(descriptor)) for array, descriptor in array_sources}
        self.paths = {str(path): frozen(descriptor) for path, descriptor in path_sources}
        self.lookup = {}
        for digest, row in records.items():
            request = row["request"]
            if sha256(canonical(request)).hexdigest() != digest:
                raise ValueError("Corrupt ASR request key in frozen cache")
            key = (frozen(request["source"]), request["language"], request["prompt"], frozen(request["contexts"]))
            if key in self.lookup:
                raise ValueError("Duplicate ASR request identity")
            self.lookup[key] = digest, row["result"]
        self.misses = []
        self.hits = 0
        self.observed = Counter()

    def __call__(self, vocal, language, prompt, contexts=(), **_options):
        if isinstance(vocal, Path):
            source = self.paths.get(str(vocal))
        else:
            entry = self.arrays.get(id(vocal))
            source = entry[1] if entry is not None and entry[0] is vocal else None
        key = (source, language, prompt, frozen(contexts))
        cached = self.lookup.get(key) if source is not None else None
        if cached is None:
            self.misses.append({"knownSource": source is not None, "language": language,
                                "prompt": prompt, "contexts": frozen(contexts)})
            raise RuntimeError("Uncached ASR source/context; benchmark refuses model inference")
        digest, result = cached
        self.hits += 1
        self.observed[digest] += 1
        return result

    def ensure_clean(self):
        if self.misses:
            # Context recovery may catch RuntimeError; a swallowed miss still invalidates the run.
            raise RuntimeError(f"Benchmark saw {len(self.misses)} uncached ASR request(s)")


def backend_hashes(repo):
    return {str(path.relative_to(repo)): sha(path) for path in sorted((repo / "backend").rglob("*.py"))}


def read_completed_metadata(directory, case):
    metadata = json.loads((directory / "metadata.json").read_text())
    if not all(metadata.get(key) for key in ("completed", "sourceHashesUnchanged", "audioHashUnchanged")):
        raise ValueError(f"Incomplete or changing trace: {directory}")
    for key in ("audioSha256", "lyrics", "language", "duration", "instrumentalSha256", "recognitionSha256", "timingHints"):
        if metadata["inputs"].get(key) != case.get(key):
            raise ValueError(f"Trace input mismatch ({key}): {directory}")
    for prefix in ("instrumental", "recognition"):
        if case.get(prefix + "Path") and not metadata.get(prefix + "HashUnchanged"):
            raise ValueError(f"Unverified {prefix} input: {directory}")
    return metadata


def review_window_audit(words, targets, windows, word_limit, time_limit):
    valid_targets = sorted(index for index in targets if 0 <= index < len(words))
    coverage = Counter(index for window in windows for index in valid_targets
                       if window.first <= index < window.last)
    rows = []
    for window in windows:
        count = window.last - window.first
        duration = window.end - window.start
        single_duration = words[window.first].end - words[window.first].start if count == 1 else None
        rows.append({"first": window.first, "last": window.last, "start": window.start,
                     "end": window.end, "wordCount": count, "durationSeconds": duration,
                     "coveredTargets": [index for index in valid_targets if window.first <= index < window.last],
                     "exceedsWordCap": count > word_limit, "exceedsTimeCap": duration > time_limit + 1e-9,
                     "singleWordDurationSeconds": single_duration,
                     "indivisibleLongWordException": single_duration is not None and single_duration > time_limit})
    audio_overlaps, word_overlaps = [], []
    for i, left in enumerate(windows):
        for j, right in enumerate(windows[i + 1:], i + 1):
            audio = min(left.end, right.end) - max(left.start, right.start)
            word_count = min(left.last, right.last) - max(left.first, right.first)
            if audio > 1e-9:
                audio_overlaps.append({"windows": [i, j], "seconds": audio})
            if word_count > 0:
                word_overlaps.append({"windows": [i, j], "wordCount": word_count})
    missed = [index for index in valid_targets if coverage[index] == 0]
    repeated = [index for index in valid_targets if coverage[index] > 1]
    return {"scope": "Only production _review_windows output; initial phrase/full-audio CTC windows are excluded. Coverage is planned target coverage, not proof that a repair was accepted.",
            "configuredMaxWords": word_limit, "configuredMaxSeconds": time_limit,
            "requestedTargets": sorted(targets), "validTargets": valid_targets,
            "invalidTargets": sorted(set(targets) - set(valid_targets)), "windows": rows,
            "maximumWords": max((row["wordCount"] for row in rows), default=0),
            "maximumSeconds": max((row["durationSeconds"] for row in rows), default=0),
            "totalPlannedAudioSeconds": sum(max(0, row["durationSeconds"]) for row in rows),
            "audioOverlaps": audio_overlaps, "wordOverlaps": word_overlaps,
            "missedTargets": missed, "repeatedTargets": repeated,
            "nonpositiveAudioWindows": [i for i, row in enumerate(rows) if row["durationSeconds"] <= 0],
            "withinWordCap": not any(row["exceedsWordCap"] for row in rows),
            "withinTimeCapOrDocumentedLongWord": not any(row["exceedsTimeCap"] and not row["indivisibleLongWordException"] for row in rows),
            "allValidTargetsPlannedExactlyOnce": not missed and not repeated}


def benchmark_case(args, case, source_hashes):
    import numpy as np
    import torch
    from backend.ai_worker import ctc, speech, timing, word_guidance

    cache_dir = args.evidence_dir / case["case"]
    reference_dir = args.reference_dir / case["case"]
    evidence_meta = read_completed_metadata(cache_dir, case)
    reference_meta = read_completed_metadata(reference_dir, case)
    if reference_meta["sourceHashes"] != source_hashes:
        raise ValueError(f"Reference trace is from different backend source: {case['case']}")
    timing_source = "backend/ai_worker/timing.py"
    if evidence_meta["sourceHashes"][timing_source] != source_hashes[timing_source]:
        raise ValueError("Cached singing mask was produced by different acoustic feature code")
    expected = json.loads((reference_dir / "payload.json").read_text())
    cache_files = {name: sha(cache_dir / name) for name in
                   ("metadata.json", "acoustic-cache.npz", "alignment-evidence.json", "asr-cache.json")}
    with np.load(cache_dir / "acoustic-cache.npz") as archive:
        arrays = {name: archive[name].copy() for name in archive.files}
    audio = arrays["audio"]
    backing = arrays.get("instrumental")
    activity = arrays["singing_frames"]
    scores = torch.from_numpy(arrays["scores"])
    step = float(arrays["frame_seconds"])
    evidence = json.loads((cache_dir / "alignment-evidence.json").read_text())
    records = json.loads((cache_dir / "asr-cache.json").read_text())
    records_hash = sha256(canonical(records)).hexdigest()
    if step != evidence["frameSeconds"] or sha256(arrays["scores"].tobytes()).hexdigest() != evidence["scores"]["sha256"]:
        raise ValueError("MMS evidence does not match its frozen descriptor")
    input_paths = {}
    for prefix in ("audio", "instrumental", "recognition"):
        if case.get(prefix + "Path"):
            path = Path(case[prefix + "Path"])
            if sha(path) != case[prefix + "Sha256"]:
                raise ValueError(f"Changed input: {path}")
            input_paths[prefix] = path
    vocal_path = input_paths["audio"]
    instrumental_path = input_paths.get("instrumental")
    if (backing is None) != (instrumental_path is None):
        raise ValueError("Backing waveform and input manifest disagree")
    decoded = {str(vocal_path): audio}
    if backing is not None:
        decoded[str(instrumental_path)] = backing
    array_hashes = {name: sha256(array.tobytes()).hexdigest() for name, array in arrays.items()}
    for array in (audio, backing, activity):
        if array is not None:
            array.setflags(write=False)
    recognition = StrictCachedRecognition(
        records,
        array_sources=[(array, {"shape": list(array.shape), "dtype": str(array.dtype),
                               "sha256": sha256(array.tobytes()).hexdigest()}) for array in decoded.values()],
        path_sources=[(path, {"path": str(path), "sha256": case[prefix + "Sha256"]})
                      for prefix, path in input_paths.items() if prefix != "recognition"],
    )
    seed = json.loads(input_paths["recognition"].read_text()) if "recognition" in input_paths else None
    signature = inspect.signature(speech._alignment_evidence)

    def cached_evidence(*positional, **keyword):
        bound = signature.bind_partial(*positional, **keyword).arguments
        if bound["samples"] is not audio or bound["language"] != case["language"] or bound["lyrics"] != case["lyrics"]:
            raise RuntimeError("Uncached alignment evidence request")
        views = bound.get("independent_views")
        if views is not None:
            views.extend([[tuple(word) for word in view] for view in evidence["independentViews"]])
        return scores, step, [tuple(word) for word in evidence["heard"]]

    def cached_audio(path, sample_rate):
        if sample_rate != speech._SAMPLE_RATE or str(path) not in decoded:
            raise RuntimeError("Uncached decoded audio request")
        return decoded[str(path)]

    def cached_activity(samples, instrumental, sample_rate, hop):
        if samples is not audio or instrumental is not backing or (sample_rate, hop) != (speech._SAMPLE_RATE, speech._HOP):
            raise RuntimeError("Uncached acoustic activity request")
        return activity

    forbidden_calls = []

    def forbidden_model(*_args, **_kwargs):
        forbidden_calls.append(True)
        raise RuntimeError("Benchmark forbids model inference and model loading")

    def align():
        return speech.align(vocal_path, case["lyrics"], case["language"],
                            instrumental=instrumental_path, recognition=seed)

    def verify(payload):
        recognition.ensure_clean()
        if forbidden_calls:
            raise RuntimeError("A caught model-loading attempt invalidates the benchmark")
        if payload != expected:
            raise AssertionError(f"Output differs from the exact production reference trace: {case['case']}")

    calls = Counter()
    windows = []
    review_plans = []
    original_review_windows = word_guidance._review_windows
    review_signature = inspect.signature(original_review_windows)

    def observed_review_windows(*positional, **keyword):
        bound = review_signature.bind(*positional, **keyword).arguments
        planned = original_review_windows(*positional, **keyword)
        calls["word_guidance._review_windows"] += 1
        review_plans.append(review_window_audit(
            bound["words"], bound["reviewed"], planned,
            word_guidance._REVIEW_MAX_WORDS, word_guidance._REVIEW_MAX_SECONDS))
        return planned

    def counted(label, function):
        @wraps(function)
        def measured(*positional, **keyword):
            calls[label] += 1
            if label == "ctc._align_window":
                window = positional[3]
                windows.append({"first": window.first, "last": window.last,
                                "start": window.start, "end": window.end})
            return function(*positional, **keyword)
        return measured

    with ExitStack() as patches:
        patches.enter_context(patch.object(speech, "read_mono", cached_audio))
        patches.enter_context(patch.object(speech, "_alignment_evidence", cached_evidence))
        patches.enter_context(patch.object(speech, "_accelerated_guidance", recognition))
        for module in (speech, ctc, timing):
            if hasattr(module, "singing_frames"):
                patches.enter_context(patch.object(module, "singing_frames", cached_activity))
        for module, name in ((speech, "_speech_model"), (speech, "emission"), (ctc, "_model"),
                             (ctc, "emission"), (timing, "get_vad_model"), (torch, "load")):
            patches.enter_context(patch.object(module, name, forbidden_model))
        # Observe calls once OUTSIDE warmups/timing; timed runs have no trace wrappers.
        with ExitStack() as observation:
            observation.enter_context(patch.object(ctc, "_align_window", counted("ctc._align_window", ctc._align_window)))
            observation.enter_context(patch.object(word_guidance, "_review_windows", observed_review_windows))
            for name in ("align_words", "align_guided", "with_word_guidance", "with_voice_onsets", "with_sung_ends", "with_sung_letters", "ordered", "voiced_frames", "vocal_onsets", "harmonic_evidence", "audible_frames"):
                observation.enter_context(patch.object(speech, name, counted("speech." + name, getattr(speech, name))))
            verify(align())
        observed_asr = dict(recognition.observed)
        for _ in range(args.warmups):
            verify(align())
        wall, cpu, lookup_counts = [], [], []
        for _ in range(args.iterations):
            hits = recognition.hits
            cpu_start, start = time.process_time_ns(), time.perf_counter_ns()
            payload = align()
            elapsed_wall, elapsed_cpu = time.perf_counter_ns() - start, time.process_time_ns() - cpu_start
            # All comparison, hashing, JSON encoding, file writes and reports are outside the timer.
            verify(payload)
            wall.append(elapsed_wall / 1e6)
            cpu.append(elapsed_cpu / 1e6)
            lookup_counts.append(recognition.hits - hits)
    if array_hashes != {name: sha256(array.tobytes()).hexdigest() for name, array in arrays.items()}:
        raise AssertionError("A cached waveform/emission/activity input was modified")
    if records_hash != sha256(canonical(records)).hexdigest():
        raise AssertionError("ASR cache was modified")
    if any(sha(path) != case[prefix + "Sha256"] for prefix, path in input_paths.items()):
        raise AssertionError("An input file changed during benchmark")
    if any(sha(cache_dir / name) != digest for name, digest in cache_files.items()):
        raise AssertionError("A frozen evidence file changed during benchmark")
    return {"case": case["case"], "durationSeconds": case["duration"], "wordCount": len(expected["words"]),
            "audioSha256": case["audioSha256"], "evidenceDirectory": str(cache_dir), "cacheFileHashes": cache_files,
            "referencePayloadSha256": sha(reference_dir / "payload.json"), "arrayHashes": array_hashes,
            "exactReferenceOutputForEveryRun": True, "inputsUnchanged": True,
            "observedCallsOutsideTimer": dict(calls), "observedCtcWindowsOutsideTimer": windows,
            "observedReviewPlansOutsideTimer": review_plans,
            "observedAsrRequestsOutsideTimer": observed_asr, "measuredAsrLookupCounts": lookup_counts,
            "cacheMisses": [], "modelCalls": 0, "warmups": args.warmups, "iterations": args.iterations,
            "wallRunsMs": wall, "cpuRunsMs": cpu, "medianWallMs": statistics.median(wall),
            "medianCpuMs": statistics.median(cpu), "minimumWallMs": min(wall), "maximumWallMs": max(wall)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-python", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--reference-dir", type=Path, required=True)
    parser.add_argument("--case", action="append")
    parser.add_argument("--warmups", type=int, default=3)
    parser.add_argument("--iterations", type=int, default=9)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.warmups < 1 or args.iterations < 3:
        parser.error("Use at least one warmup and three measured repetitions")
    if args.output.exists():
        parser.error("Output exists; use a fresh result path")
    os.environ.update(OMP_NUM_THREADS="1", MKL_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1",
                      NUMBA_CACHE_DIR="/tmp/karaoke-numba-cache")
    sys.path.insert(0, str(args.repo_python.resolve()))
    import torch
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    cases = json.loads(args.inputs.read_text())["cases"]
    if args.case:
        if not set(args.case) <= {case["case"] for case in cases}:
            parser.error("Unknown selected case")
        cases = [case for case in cases if case["case"] in args.case]
    if not cases or any(case.get("timingHints") != [] for case in cases):
        parser.error("Require nonempty cases and no reference timing hints")
    sources = backend_hashes(args.repo_python)
    report = {"startedUtc": datetime.now(timezone.utc).isoformat(), "completed": False,
              "scope": __doc__, "repositoryPython": str(args.repo_python.resolve()),
              "scriptSha256": sha(Path(__file__)), "inputManifestSha256": sha(args.inputs),
              "sourceHashesBefore": sources, "environment": {name: os.environ[name] for name in
              ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMBA_CACHE_DIR")},
              "torchVersion": torch.__version__, "torchThreads": torch.get_num_threads(),
              "torchInteropThreads": torch.get_num_interop_threads(), "python": sys.version,
              "cpuAffinity": sorted(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
              "timingExclusions": ["Imports and decoding", "ASR/MMS/model loading", "Model-assisted singing-mask generation", "Tracing, result comparison, hashing, JSON and all file writes"],
              "cases": []}
    try:
        for case in cases:
            report["cases"].append(benchmark_case(args, case, sources))
        report["sourceHashesAfter"] = backend_hashes(args.repo_python)
        if report["sourceHashesAfter"] != sources:
            raise AssertionError("Backend source changed during benchmark")
        report["completed"] = True
    except Exception as error:
        report.update(error=repr(error), traceback=traceback.format_exc())
        raise
    finally:
        report["finishedUtc"] = datetime.now(timezone.utc).isoformat()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps([{key: case[key] for key in ("case", "medianWallMs", "medianCpuMs", "modelCalls")}
                      for case in report["cases"]], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
