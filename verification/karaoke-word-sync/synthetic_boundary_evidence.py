"""Reproduce the controlled boundary examples against either project version.

Usage: python synthetic_boundary_evidence.py PATH_TO_PYTHON PATH_TO_CURRENT_TESTS OUTPUT_JSON
No model weights or audio files are loaded. The pipeline-commit case deliberately
isolates committing an already accepted acoustic pair; it is not an ASR benchmark.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys


def module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("python_root", type=Path)
    parser.add_argument("current_tests", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.python_root.resolve()))
    import numpy as np
    import pytest
    from backend.ai_worker import ctc, word_guidance

    cases = module(args.current_tests / "test_word_timing_review.py", "timing_cases")
    wave = module(args.current_tests / "test_sung_boundary_regressions.py", "wave_cases")

    def rows(words):
        return [dict(text=w.text, start=round(w.start, 6), end=round(w.end, 6),
                     letters=list(w.letters), confidence=w.score) for w in words]

    actual = [ctc.AlignedWord("дом", 1, 2, (1, 1.04, 1.98), 0.99),
              ctc.AlignedWord("там", 2.04, 2.4, (2.04, 2.12, 2.38), 0.99)]
    wrong = [cases._word("дом", 1, 1.1), cases._word("там", 1.1, 2.4)]
    result = word_guidance.with_word_guidance(
        wrong, cases._emissions(actual), 0.02, [ctc.Window(0, 2, 0.5, 3)],
        {i: (w.start, w.end) for i, w in enumerate(actual)},
        cases._activity((1, 2.4)), 0.6, reviewed=frozenset({0}))
    evidence = {"localSyntheticCTC": {"input": rows(wrong), "output": rows(result)}}
    with pytest.MonkeyPatch.context() as patch:
        original = [cases._word("дорога", 1, 1.1), cases._word("домой", 1.1, 2.5)]
        candidate = [cases._word("дорога", 1, 2, 0.99), cases._word("домой", 2, 2.5, 0.99)]
        output = cases._isolated_pipeline(patch, original, candidate)
        evidence["acceptedPairCommit"] = {"input": rows(original), "output": output}
    evidence["fastWords"] = {}
    for text in ("и", "і"):
        word = ctc.AlignedWord(text, 1, 1.03, (1,), 0.8)
        result = ctc.with_sung_ends([word], wave._voice([(1, 1.03, 0.2)]))
        evidence["fastWords"][text] = {"input": rows([word]), "output": rows(result)}
    evidence["heldFinalConsonants"] = {}
    for text in ("дом", "дім"):
        import torch
        from torchaudio.pipelines import MMS_FA
        tokens = [t for char in ctc._character_tokens(text) for t in char]
        size = len(MMS_FA.get_dict(star=None))
        probabilities = torch.full((85, size), 0.2 / (size - 1))
        probabilities[:, 0] = 0.8
        for frame, token in zip((10, 12, 60), tokens, strict=True):
            probabilities[frame] = 0.05 / (size - 1)
            probabilities[frame, token] = 0.95
        probabilities[14] = 0.05 / (size - 2)
        probabilities[14, 0], probabilities[14, tokens[-1]] = 0.75, 0.2
        scores = probabilities.log()
        raw = ctc.align_words(scores, 0.02, [text])
        activity = np.zeros(170, bool)
        activity[20:122] = True
        times = np.arange(27200) / 16000
        samples = (0.2 * np.sin(2 * np.pi * 220 * times)
                   * ((times >= 0.2) & (times < 1.22))).astype(np.float32)
        timed = ctc.with_sung_ends(raw, samples, voiced=activity)
        final = ctc.with_sung_letters(timed, scores, 0.02, activity, {0: (0.2, 1.22)}) \
            if hasattr(ctc, "with_sung_letters") else timed
        evidence["heldFinalConsonants"][text] = {
            "rawCTC": rows(raw), "sungEnds": rows(timed), "final": rows(final)}
    args.output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
