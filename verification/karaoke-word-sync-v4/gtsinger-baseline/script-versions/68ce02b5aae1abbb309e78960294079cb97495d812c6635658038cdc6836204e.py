"""Trace production alignment with fresh existing models, or replay its evidence.

The inference manifest contains audio and transcript only: no word/phone labels.
Replay is deliberately strict: an uncached ASR request raises instead of silently
substituting another result. Fresh-run times include loading/decoding/inference.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from functools import wraps
from hashlib import sha256
import inspect
import json
import os
from pathlib import Path
import resource
import sys
import time
import traceback

parser = argparse.ArgumentParser()
parser.add_argument("--repo-python", type=Path, required=True)
parser.add_argument("--inputs", type=Path, required=True)
parser.add_argument("--case", required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--cache-from", type=Path)
args = parser.parse_args()
sys.path.insert(0, str(args.repo_python))

import numpy as np
import torch
from backend.ai_worker import ctc, speech
from backend.ai_worker.runtime import AlignmentReuse


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def serial(value):
    if is_dataclass(value):
        return {key: serial(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {str(key): serial(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [serial(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return sorted(serial(item) for item in value)
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return {"shape": list(value.shape), "dtype": str(value.dtype), "sha256": sha256(value.tobytes()).hexdigest()}
    if isinstance(value, torch.Tensor):
        return serial(value.detach().cpu().numpy())
    if isinstance(value, Path):
        return str(value)
    return value


def write_json(path, value):
    path.write_text(json.dumps(serial(value), ensure_ascii=False, indent=2))


args.output.mkdir(parents=True, exist_ok=True)
manifest = json.loads(args.inputs.read_text())
case = next(item for item in manifest["cases"] if item["case"] == args.case)
audio_path = Path(case["audioPath"])
assert sha256(audio_path.read_bytes()).hexdigest() == case["audioSha256"]
assert case["timingHints"] == []
model_proof = json.loads(Path("/tmp/karaoke-sync-v4/model-downloads.json").read_text())
sources = {
    str(path.relative_to(args.repo_python)): sha256(path.read_bytes()).hexdigest()
    for path in sorted((args.repo_python / "backend").rglob("*.py"))
}
trace = []
arrays = {}
asr_cache = {}
cached_evidence = None
if args.cache_from:
    cached_evidence = json.loads((args.cache_from / "alignment-evidence.json").read_text())
    with np.load(args.cache_from / "acoustic-cache.npz") as archive:
        source_arrays = {name: archive[name].copy() for name in archive.files}
    asr_cache = json.loads((args.cache_from / "asr-cache.json").read_text())
sequence = 0


def cache_arrays():
    temporary = args.output / "acoustic-cache.pending.npz"
    np.savez_compressed(temporary, **arrays)
    temporary.replace(args.output / "acoustic-cache.npz")


def flush_trace():
    write_json(args.output / "stages.json", trace)


def record_stage(module, name):
    original = getattr(module, name)
    label = f"{module.__name__.rsplit('.', 1)[-1]}.{name}"

    @wraps(original)
    def invoke(*positional, **keyword):
        global sequence
        sequence += 1
        event = {"sequence": sequence, "stage": label, "startedOffsetSeconds": time.perf_counter() - started}
        for value in positional:
            if isinstance(value, list) and value and isinstance(value[0], ctc.AlignedWord):
                event["inputWords"] = serial(value)
                break
        if "reviewed" in keyword:
            event["reviewed"] = serial(keyword["reviewed"])
        begin = time.perf_counter()
        try:
            result = original(*positional, **keyword)
        except BaseException as error:
            event["error"] = repr(error)
            event["elapsedSeconds"] = time.perf_counter() - begin
            trace.append(event)
            flush_trace()
            raise
        event["elapsedSeconds"] = time.perf_counter() - begin
        if isinstance(result, list) and (not result or isinstance(result[0], ctc.AlignedWord)):
            event["outputWords"] = serial(result)
        elif isinstance(result, dict) and "words" in result:
            event["payload"] = serial(result)
        if name == "read_mono":
            arrays["audio"] = result.copy()
        elif name in {"singing_frames", "voiced_frames", "vocal_onsets"}:
            arrays[name] = result.copy()
            event["outputArray"] = serial(result)
            cache_arrays()
        trace.append(event)
        flush_trace()
        return result

    setattr(module, name, invoke)


original_guidance = speech._accelerated_guidance


@wraps(original_guidance)
def guidance(vocal, language, prompt, contexts=(), **options):
    source = serial(vocal) if isinstance(vocal, np.ndarray) else {"path": str(vocal), "sha256": sha256(Path(vocal).read_bytes()).hexdigest()}
    request = {"source": source, "language": language, "prompt": prompt, "contexts": serial(contexts)}
    key = sha256(canonical(request)).hexdigest()
    begin = time.perf_counter()
    print(f"ASR start contexts={len(contexts)} replay={bool(args.cache_from)}", flush=True)
    if args.cache_from:
        if key not in asr_cache:
            write_json(args.output / "uncached-asr-request.json", request)
            raise RuntimeError("Uncached ASR context; fresh independent inference required")
        result = asr_cache[key]["result"]
    else:
        result = original_guidance(vocal, language, prompt, contexts, **options)
        asr_cache[key] = {"request": request, "result": serial(result)}
        write_json(args.output / "asr-cache.json", asr_cache)
    trace.append({"stage": "ASR", "elapsedSeconds": time.perf_counter() - begin, "requestKey": key, "request": request, "result": serial(result), "replay": bool(args.cache_from)})
    flush_trace()
    print(f"ASR complete {time.perf_counter() - begin:.3f}s", flush=True)
    return result


speech._accelerated_guidance = guidance
original_evidence = speech._alignment_evidence
evidence_signature = inspect.signature(original_evidence)


@wraps(original_evidence)
def evidence(*positional, **keyword):
    print("Alignment evidence start", flush=True)
    begin = time.perf_counter()
    bound = evidence_signature.bind_partial(*positional, **keyword)
    views = bound.arguments.get("independent_views")
    if args.cache_from:
        assert cached_evidence is not None
        scores = torch.from_numpy(source_arrays["scores"].copy())
        step = float(source_arrays["frame_seconds"])
        heard = [tuple(item) for item in cached_evidence["heard"]]
        if views is not None:
            views.extend([[tuple(item) for item in view] for view in cached_evidence["independentViews"]])
        result = scores, step, heard
    else:
        result = original_evidence(*positional, **keyword)
    scores, step, heard = result
    arrays["scores"] = scores.detach().cpu().numpy().copy()
    arrays["frame_seconds"] = np.array(step)
    cache_arrays()
    snapshot = {"heard": serial(heard), "independentViews": serial(views or []), "scores": serial(scores), "frameSeconds": step, "elapsedSeconds": time.perf_counter() - begin}
    write_json(args.output / "alignment-evidence.json", snapshot)
    trace.append({"stage": "alignment_evidence", **snapshot})
    flush_trace()
    print(f"Alignment evidence complete {time.perf_counter() - begin:.3f}s, cache ready", flush=True)
    return result


speech._alignment_evidence = evidence
for name in ("read_mono", "align_words", "align_guided", "with_word_guidance", "with_voice_onsets", "with_sung_ends", "ordered", "with_sung_letters", "alignment_payload", "singing_frames", "voiced_frames", "vocal_onsets"):
    record_stage(speech, name)
record_stage(ctc, "_align_window")
record_stage(ctc, "ordered")
if not args.cache_from:
    original_emission = speech.emission

    @wraps(original_emission)
    def emission(samples):
        begin = time.perf_counter()
        print("MMS emission start", flush=True)
        result = original_emission(samples)
        trace.append({"stage": "MMS emission", "elapsedSeconds": time.perf_counter() - begin, "scores": serial(result[0]), "frameSeconds": result[1]})
        flush_trace()
        print(f"MMS emission complete {time.perf_counter() - begin:.3f}s", flush=True)
        return result

    speech.emission = emission

torch.set_num_threads(int(os.getenv("OMP_NUM_THREADS", "2")))
torch.set_num_interop_threads(1)
started = time.perf_counter()
metadata = {
    "startedUtc": datetime.now(timezone.utc).isoformat(),
    "scope": "isolated vocal alignment, including decoding/inference/model loads for fresh run; excludes separation/pitch/full song pipeline",
    "mode": "cached-evidence-replay" if args.cache_from else "fresh-existing-model-inference",
    "inputs": case,
    "inputManifestSha256": sha256(args.inputs.read_bytes()).hexdigest(),
    "referenceLabelsPassedToModels": False,
    "models": model_proof,
    "threads": torch.get_num_threads(),
    "sourceHashes": sources,
    "python": sys.version,
    "torch": torch.__version__,
    "scriptSha256": sha256(Path(__file__).read_bytes()).hexdigest(),
}
write_json(args.output / "metadata.json", metadata)
try:
    reuse = None if args.cache_from else AlignmentReuse(args.output / "model-reuse", reserve_bytes=100_000_000)
    payload = speech.align(audio_path, case["lyrics"], case["language"], reuse=reuse)
    elapsed = time.perf_counter() - started
    write_json(args.output / "payload.json", payload)
    write_json(args.output / "asr-cache.json", asr_cache)
    cache_arrays()
    sources_after = {name: sha256((args.repo_python / name).read_bytes()).hexdigest() for name in sources}
    metadata.update({"finishedUtc": datetime.now(timezone.utc).isoformat(), "elapsedSeconds": elapsed, "maxRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, "sourceHashesUnchanged": sources_after == sources, "audioHashUnchanged": sha256(audio_path.read_bytes()).hexdigest() == case["audioSha256"], "completed": True})
    write_json(args.output / "metadata.json", metadata)
    print(json.dumps({"case": args.case, "elapsedSeconds": elapsed, "words": payload["words"]}, ensure_ascii=False), flush=True)
except BaseException as error:
    metadata.update({"completed": False, "error": repr(error), "traceback": traceback.format_exc(), "elapsedSeconds": time.perf_counter() - started})
    write_json(args.output / "metadata.json", metadata)
    raise
