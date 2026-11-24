"""Offline comparison of lyric documents, requiring explicit reference provenance.

Install optional tools with `pip install -e .[evaluation]` in the developer environment.
No alignment, time shifting or model inference is performed by this evaluator.
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import sys
import time

import numpy as np
from numpy.typing import NDArray

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.lyrics.codec import decode_document
from backend.lyrics.domain import LyricsDocument, Word
from backend.text_normalization import normalize_search


def _errors(values: list[float]) -> dict[str, float | int] | None:
    if not values:
        return None
    errors = np.abs(np.asarray(values)) * 1000
    return {
        "count": len(values),
        "medianMs": float(np.median(errors)),
        "p95Ms": float(np.percentile(errors, 95)),
        "maxMs": float(np.max(errors)),
        "within50Ms": float(np.mean(errors <= 50 + 1e-6)),
        "within100Ms": float(np.mean(errors <= 100 + 1e-6)),
    }


def _tokens(words: Sequence[Word]) -> list[str]:
    # Preserve Ukrainian letters, apostrophes and written repetitions.
    return [normalize_search(word.text) for word in words]


def pitch_metrics(
    reference: NDArray[np.float64], estimated: NDArray[np.float64]
) -> dict[str, float] | None:
    from mir_eval import melody

    if not np.any(reference):
        return None
    ref_voiced, est_voiced = reference > 0, estimated > 0
    arguments = (ref_voiced, melody.hz2cents(reference), est_voiced, melody.hz2cents(estimated))
    # Frames already share the source timeline. Avoid resampling or padding
    # an excerpt with an extra frame at zero in melody.evaluate().
    return {
        "Voicing Recall": float(melody.voicing_recall(ref_voiced, est_voiced)),
        "Voicing False Alarm": float(melody.voicing_false_alarm(ref_voiced, est_voiced)),
        **{
            name: float(metric(*arguments))
            for name, metric in {
                "Raw Pitch Accuracy": melody.raw_pitch_accuracy,
                "Raw Chroma Accuracy": melody.raw_chroma_accuracy,
                "Overall Accuracy": melody.overall_accuracy,
            }.items()
        },
    }


def evaluate(
    reference: LyricsDocument,
    estimated: LyricsDocument,
    *,
    start: float = 0,
    end: float | None = None,
) -> dict[str, object]:
    import jiwer

    reference.validate()
    estimated.validate()
    if abs(reference.duration - estimated.duration) > 0.01:
        raise ValueError("Documents must describe the same recording duration")
    end = reference.duration if end is None else end
    if not 0 <= start < end <= reference.duration:
        raise ValueError("Evaluation window must be inside the recording")
    ref_words = [word for word in reference.words if start <= word.start < end]
    est_words = [word for word in estimated.words if start <= word.start < end]
    ref_tokens, est_tokens = _tokens(ref_words), _tokens(est_words)
    words = jiwer.process_words(" ".join(ref_tokens), " ".join(est_tokens))
    matches = [
        (i, j)
        for chunk in words.alignments[0]
        if chunk.type == "equal"
        for i, j in zip(
            range(chunk.ref_start_idx, chunk.ref_end_idx),
            range(chunk.hyp_start_idx, chunk.hyp_end_idx),
            strict=True,
        )
    ]
    starts: list[float] = []
    ends: list[float] = []
    letters: list[float] = []
    for i, j in matches:
        ref_word, est_word = ref_words[i], est_words[j]
        starts.append(est_word.start - ref_word.start)
        ends.append(est_word.end - ref_word.end)
        if ref_word.letters and est_word.letters and len(ref_word.letters) == len(est_word.letters):
            letters.extend(b - a for a, b in zip(ref_word.letters, est_word.letters, strict=True))
    # Include missed notes and rests. Comparing only intersecting voiced frames
    # would hide missed vocals and inflate the reported pitch accuracy.
    ref_frames = np.array(list(reference.target_frames()), dtype=float)
    est_frames = np.array(list(estimated.target_frames()), dtype=float)
    ref_frames = ref_frames[(ref_frames[:, 0] >= start) & (ref_frames[:, 0] < end)]
    est_frames = est_frames[(est_frames[:, 0] >= start) & (est_frames[:, 0] < end)]
    ref_midi, est_midi = ref_frames[:, 1], est_frames[:, 1]
    ref_hz = np.where(np.isfinite(ref_midi), 440 * 2 ** ((ref_midi - 69) / 12), 0)
    est_hz = np.where(np.isfinite(est_midi), 440 * 2 ** ((est_midi - 69) / 12), 0)
    reference_letters = sum(len(word.letters) for word in ref_words)
    return {
        "window": {"start": start, "end": end},
        "text": {
            "wer": float(words.wer),
            "substitutions": int(words.substitutions),
            "deletions": int(words.deletions),
            "insertions": int(words.insertions),
            "referenceWords": len(ref_tokens),
        },
        "timing": {
            "matchedWords": len(matches),
            "matchedReferenceFraction": len(matches) / len(ref_tokens) if ref_tokens else None,
            "start": _errors(starts),
            "end": _errors(ends),
            "letters": _errors(letters),
            "comparedLetterFraction": len(letters) / reference_letters
            if reference_letters
            else None,
            "worstEntries": [
                {
                    "referenceIndex": i,
                    "estimatedIndex": j,
                    "text": ref_words[i].text,
                    "referenceStart": ref_words[i].start,
                    "estimatedStart": est_words[j].start,
                    "startErrorMs": round(start * 1000, 3),
                    "endErrorMs": round(end * 1000, 3),
                }
                for (i, j), start, end in sorted(
                    zip(matches, starts, ends, strict=True),
                    key=lambda row: max(abs(row[1]), abs(row[2])),
                    reverse=True,
                )[:20]
            ],
        },
        "pitch": pitch_metrics(ref_hz, est_hz),
        "referenceVoicedSeconds": float(np.count_nonzero(ref_hz) / 100),
        "estimatedVoicedSeconds": float(np.count_nonzero(est_hz) / 100),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("estimated", type=Path)
    parser.add_argument(
        "--reference-kind", required=True, choices=("manual", "model", "baseline", "synthetic")
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--end", type=float)
    args = parser.parse_args()
    reference, estimated = args.reference.read_bytes(), args.estimated.read_bytes()
    started = time.perf_counter()
    result = {
        "referenceKind": args.reference_kind,
        "referenceSha256": hashlib.sha256(reference).hexdigest(),
        "estimatedSha256": hashlib.sha256(estimated).hexdigest(),
        "interpretation": (
            "Error against supplied manual reference; reference correctness requires human review."
            if args.reference_kind == "manual"
            else "Comparison only; this reference does not establish real-world accuracy."
        ),
        "frameStepMs": 10,
        "pitchToleranceCents": 50,
        "evaluators": {name: version(name) for name in ("jiwer", "mir_eval")},
        "globalTimeShiftSeconds": 0,
        "metrics": evaluate(
            decode_document(reference.decode("utf-8")),
            decode_document(estimated.decode("utf-8")),
            start=args.start,
            end=args.end,
        ),
    }
    result["evaluationSeconds"] = time.perf_counter() - started
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    print(args.output)


if __name__ == "__main__":
    main()
