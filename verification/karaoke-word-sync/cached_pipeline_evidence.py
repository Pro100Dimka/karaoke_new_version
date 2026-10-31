"""Replay existing vocal fragments through speech.align without ASR/MMS inference.

Usage:
  python cached_pipeline_evidence.py /path/to/repo/python /path/to/results.json
      [--fixtures /path/to/fixtures] [--iterations 5]

The existing bundled VAD runs once when preparing a missing activity cache. Timed
runs reuse that mask and cached ASR/CTC. This is NOT a full-song/model benchmark.
"""

from __future__ import annotations

import argparse
from collections import Counter
from contextlib import ExitStack
from datetime import UTC, datetime
from functools import wraps
from hashlib import sha256
import json
from pathlib import Path
import statistics
import sys
import time
from unittest.mock import patch


def digest(data):
    return sha256(data).hexdigest()


def word_rows(words):
    return [
        {
            "text": word.text,
            "start": round(word.start, 6),
            "end": round(word.end, 6),
            "letters": [round(at, 6) for at in word.letters],
            "confidence": word.score,
            "diagnostics": list(getattr(word, "diagnostics", ())),
        }
        for word in words
    ]


def replay(repo, fixtures, name, iterations):
    import numpy as np
    import torch

    from backend.ai_worker import ctc, speech, timing

    with np.load(fixtures / "wildways-verse-entry.npz") as fixture:
        case = json.loads(str(fixture[name + "_metadata"]))
        vocal = fixture[name + "_vocal"].astype(np.float32)
        backing = fixture[name + "_instrumental"].astype(np.float32)
        scores = torch.from_numpy(fixture[name + "_scores"])
    inputs = {
        "vocalSha256": digest(vocal.tobytes()),
        "instrumentalSha256": digest(backing.tobytes()),
        "emissionsSha256": digest(scores.numpy().tobytes()),
    }
    cache_root = Path(__file__).resolve().parent / "acoustic_cache"
    cache_root.mkdir(exist_ok=True)
    cache_key = digest(
        (json.dumps(inputs, sort_keys=True) + Path(timing.__file__).read_text()).encode()
    )[:20]
    cache_path = cache_root / f"{name}-{cache_key}.npy"
    if cache_path.exists():
        activity = np.load(cache_path)
    else:
        activity = timing.singing_frames(vocal, backing, 16_000, 160)
        np.save(cache_path, activity)

    events, context_requests = [], []
    recording = False
    calls = Counter()

    def no_extra_recognition(_vocal, _language, _prompt, contexts=(), **_kwargs):
        if recording:
            context_requests.extend(
                {"start": start, "end": end, "prompt": prompt} for start, end, prompt in contexts
            )
        raise FileNotFoundError("Cached replay contains no additional ASR decoder output")

    def forbidden_model(*_args, **_kwargs):
        raise AssertionError("This replay must not run ASR/MMS model inference")

    def observe(stage, function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            if not recording:
                return function(*args, **kwargs)
            calls[stage] += 1
            event = {"stage": stage, "call": calls[stage]}
            if stage in {
                "with_word_guidance", "with_voice_onsets", "with_sung_ends", "with_sung_letters", "ordered"
            }:
                event["input"] = word_rows(args[0])
            if "reviewed" in kwargs:
                event["reviewedIndices"] = sorted(kwargs["reviewed"])
            started = time.perf_counter()
            result = function(*args, **kwargs)
            event["durationMs"] = (time.perf_counter() - started) * 1000
            event["output"] = word_rows(result)
            events.append(event)
            return result

        return wrapped

    with ExitStack() as patches:
        patches.enter_context(
            patch.object(
                speech,
                "read_mono",
                lambda path, *_: backing if path.name == "backing.wav" else vocal,
            )
        )
        patches.enter_context(
            patch.object(
                speech,
                "_alignment_evidence",
                lambda *_args, **_kwargs: (scores, 0.02, list(case["heard"])),
            )
        )
        patches.enter_context(patch.object(speech, "_accelerated_guidance", no_extra_recognition))
        patches.enter_context(patch.object(speech, "_speech_model", forbidden_model))
        patches.enter_context(patch.object(ctc, "_model", forbidden_model))
        patches.enter_context(
            patch.object(speech, "singing_frames", lambda *_args: activity.copy())
        )
        patches.enter_context(patch.object(ctc, "singing_frames", lambda *_args: activity.copy()))
        for stage in (
            "align_words",
            "align_guided",
            "with_word_guidance",
            "with_voice_onsets",
            "with_sung_ends",
            "with_sung_letters",
            "ordered",
        ):
            if hasattr(speech, stage):
                patches.enter_context(
                    patch.object(speech, stage, observe(stage, getattr(speech, stage)))
                )

        def align():
            return speech.align(
                Path("voice.wav"), case["lyrics"], "Russian", case["hints"], Path("backing.wav")
            )

        align()  # Warm imports, romanization, FFT and existing CPU kernels.
        recording = True
        payload = align()
        recording = False
        durations = []
        for _ in range(iterations):
            started = time.perf_counter()
            repeated = align()
            durations.append((time.perf_counter() - started) * 1000)
            if repeated != payload:
                raise AssertionError(f"Non-deterministic replay: {name}")

    words = payload["words"]
    assertions = {
        "inputVocalUnchanged": inputs["vocalSha256"] == digest(vocal.tobytes()),
        "inputInstrumentalUnchanged": inputs["instrumentalSha256"] == digest(backing.tobytes()),
        "positiveWordDurations": all(word["start"] < word["end"] for word in words),
        "nonoverlappingWords": all(
            left["end"] <= right["start"] for left, right in zip(words, words[1:])
        ),
        "lettersInsideWords": all(
            word["start"] <= moment <= word["end"] for word in words for moment in word["letters"]
        ),
        "orderedLetters": all(
            a <= b for word in words for a, b in zip(word["letters"], word["letters"][1:])
        ),
    }
    if name in {"fast", "native_fast"}:
        assertions.update(
            {
                "wordByAfter2_5Seconds": words[2]["start"] > 2.5,
                "wordByNotCollapsed": words[2]["end"] - words[2]["start"] > 0.3,
                "wordNamnogoInItsPhrase": 3 < words[3]["start"] < 4.2,
                "wordLegcheInItsPhrase": 4 < words[4]["start"] < 5.2,
            }
        )
    else:
        assertions.update(
            {
                "shortReplyBeforeInstrumental": 13 < words[13]["start"] < 14.5,
                "shortReplyEndsBefore16_2Seconds": words[15]["end"] < 16.2,
                "previousWordNotCrushed": words[11]["start"]
                < words[12]["start"]
                < words[12]["end"],
            }
        )
    return {
        "case": name,
        "fixture": "wildways-verse-entry.npz",
        "sourceOffsetSeconds": case["offset"],
        "fragmentDurationSeconds": len(vocal) / 16_000,
        "lyrics": case["lyrics"],
        "inputs": inputs,
        "cachedIndependentAsr": case["heard"],
        "missingLocalRecognitionRequests": context_requests,
        "stages": events,
        "finalPayload": payload,
        "assertions": assertions,
        "runtime": {
            "warmupRuns": 1,
            "measuredRuns": iterations,
            "medianMs": statistics.median(durations),
            "runsMs": durations,
            "scope": "CTC forced alignment and postprocessing; cached emissions, ASR and singing mask",
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo_python", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--fixtures", type=Path)
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument(
        "--cases",
        nargs="+",
        choices=["fast", "native_fast", "reply"],
        default=["fast", "native_fast", "reply"],
    )
    args = parser.parse_args()
    if args.iterations < 1:
        parser.error("--iterations must be positive")
    repo = args.repo_python.resolve()
    sys.path.insert(0, str(repo))
    import torch
    import torchaudio

    torch.set_num_threads(1)
    report = {
        "createdAtUtc": datetime.now(UTC).isoformat(),
        "repositoryPython": str(repo),
        "torchVersion": torch.__version__,
        "torchaudioVersion": torchaudio.__version__,
        "cpuThreads": torch.get_num_threads(),
        "limitations": [
            "Real cropped vocal/backing samples with recorded CTC emissions and ASR; not complete songs.",
            "No new ASR/MMS inference. Missing contextual ASR results remain explicitly unavailable.",
            "Existing bundled VAD runs only to prepare a missing acoustic mask; excluded from measured runs.",
            "Timings compare the same CPU cached alignment/postprocessing path, not full processing speed.",
            "Reference assertions are the existing fixture regression bounds, not manually measured phoneme ground truth.",
        ],
        "sourceHashes": {
            str(path.relative_to(repo)): digest(path.read_bytes())
            for path in [
                *(
                    repo / "backend/ai_worker" / f"{name}.py"
                    for name in ["ctc", "speech", "word_guidance", "recognition", "timing"]
                ),
                repo / "backend/processing/reporting.py",
            ]
        },
        "cases": [],
    }
    for name in args.cases:
        result = replay(repo, args.fixtures or repo / "tests/fixtures", name, args.iterations)
        report["cases"].append(result)
        print(
            f"{name}: {result['runtime']['medianMs']:.3f} ms; assertions={all(result['assertions'].values())}",
            flush=True,
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return 0 if all(all(case["assertions"].values()) for case in report["cases"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
