"""Read-only planner/real-CTC comparison; no recognition or emission inference."""

from __future__ import annotations

import ast
from dataclasses import asdict, replace
import hashlib
import json
import platform
from pathlib import Path
import random
import statistics
import time

import numpy as np
import torch

from backend.ai_worker import ctc, word_guidance


ROOT = Path('/tmp/karaoke-sync-v2/windows')
BASELINE_SOURCE = (ROOT / 'word_guidance.before.py').read_text()
namespace = dict(word_guidance.__dict__)
node = next(
    node for node in ast.parse(BASELINE_SOURCE).body
    if isinstance(node, ast.FunctionDef) and node.name == '_review_windows'
)
exec(compile(ast.Module(body=[node], type_ignores=[]), 'baseline_review_windows.py', 'exec'), namespace)
baseline = namespace['_review_windows']


def old_planner(words, heard, reviewed, margin, total, *, voiced=None):
    return baseline(words, heard, reviewed, margin, total)


def coalesced_planner(*args, **kwargs):
    """Scratch experiment: greedily pack adjacent complete existing windows under both caps."""
    result = []
    for window in word_guidance._review_windows(*args, **kwargs):
        if (
            result
            and result[-1].last == window.first
            and window.last - result[-1].first <= 12
            and window.end - result[-1].start <= 8
        ):
            result[-1] = replace(result[-1], last=window.last, end=window.end)
        else:
            result.append(window)
    return result


def fixture(count=100):
    texts = ['дом', 'там', 'дім', 'сад']
    words = [
        ctc.AlignedWord(
            texts[i % len(texts)], start := i * 0.8, start + 0.4,
            (start, start + 0.16, start + 0.38), 0.1,
        )
        for i in range(count)
    ]
    total = count * 0.8
    scores = torch.full((round(total / 0.02), 28), float(np.log(1e-6)))
    scores[:, 0] = float(np.log(0.99))
    activity = np.zeros(round(total * 100), dtype=bool)
    for word in words:
        activity[round(word.start * 100):round(word.end * 100)] = True
        for at, tokens in zip(word.letters, ctc._character_tokens(word.text), strict=True):
            for offset, token in enumerate(tokens):
                frame = round(at / 0.02) + offset
                scores[frame, 0] = float(np.log(0.01))
                scores[frame, token] = float(np.log(0.99))
    return words, scores, activity, total


def summarize(samples):
    values = [value * 1000 for value in samples]
    return {
        'median_ms': statistics.median(values),
        'minimum_ms': min(values),
        'maximum_ms': max(values),
        'samples_ms': values,
    }


def main():
    words, scores, activity, total = fixture()
    heard = {i: (word.start, word.end) for i, word in enumerate(words)}
    planners = {
        'baseline': old_planner,
        'bounded': word_guidance._review_windows,
        'scratch_coalesced': coalesced_planner,
    }
    patterns = {
        'every_third_33_flags': frozenset(range(0, 99, 3)),
        'dense_100_flags': frozenset(range(100)),
        'sparse_10_flags': frozenset(range(0, 100, 10)),
    }
    result = {
        'environment': {
            'python': platform.python_version(), 'torch': torch.__version__,
            'torch_threads': torch.get_num_threads(), 'torch_interop_threads': torch.get_num_interop_threads(),
            'baseline_sha256': hashlib.sha256(BASELINE_SOURCE.encode()).hexdigest(),
            'current_sha256': hashlib.sha256(Path(word_guidance.__file__).read_bytes()).hexdigest(),
            'scores_shape': list(scores.shape), 'warmup_rounds': 2, 'measured_rounds': 9,
            'note': 'CPU, cached synthetic character scores; includes real torchaudio forced alignment and reconstruction, excludes model/ASR/audio decoding.',
        },
        'patterns': {},
    }
    output = ROOT / f'benchmark_cached_ctc_threads{torch.get_num_threads()}.json'
    for pattern, reviewed in patterns.items():
        samples = {name: {'planner': [], 'ctc': [], 'total': []} for name in planners}
        details = {}
        for iteration in range(11):
            names = list(planners)
            random.Random(iteration + 13).shuffle(names)
            for name in names:
                begin = time.perf_counter()
                windows = planners[name](words, heard, reviewed, .6, total, voiced=activity)
                planned = time.perf_counter()
                aligned = [
                    ctc._align_window(scores, .02, [word.text for word in words[win.first:win.last]], win)
                    for win in windows
                ]
                finished = time.perf_counter()
                if iteration >= 2:
                    samples[name]['planner'].append(planned - begin)
                    samples[name]['ctc'].append(finished - planned)
                    samples[name]['total'].append(finished - begin)
                if name not in details:
                    errors = [
                        max(abs(candidate.start - words[index].start), abs(candidate.end - words[index].end))
                        for window, aligned_words in zip(windows, aligned, strict=True)
                        for index, candidate in enumerate(aligned_words, window.first)
                    ]
                    details[name] = {
                        'calls': len(windows), 'max_words': max(w.last-w.first for w in windows),
                        'max_seconds': max(w.end-w.start for w in windows),
                        'aligned_word_count': sum(w.last-w.first for w in windows),
                        'audio_overlap_seconds': sum(max(0,a.end-b.start) for a,b in zip(windows, windows[1:])),
                        'largest_alignment_error_seconds': max(errors),
                        'windows': [asdict(w) for w in windows],
                    }
        result['patterns'][pattern] = {
            name: details[name] | {phase: summarize(values) for phase, values in phases.items()}
            for name, phases in samples.items()
        }
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
        print(pattern, json.dumps({name: {'calls': data['calls'], 'total_median_ms': data['total']['median_ms'], 'ctc_median_ms': data['ctc']['median_ms'], 'planner_median_ms': data['planner']['median_ms'], 'max_error_s': data['largest_alignment_error_seconds']} for name,data in result['patterns'][pattern].items()}), flush=True)
    print(f'Complete: {output.name}', flush=True)


if __name__ == '__main__':
    main()
