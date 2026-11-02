"""Unchanged production worker CLI, with deterministic seeds and sidecar evidence."""
from __future__ import annotations

from dataclasses import asdict
from functools import wraps
from hashlib import sha256
import inspect
import json
import os
from pathlib import Path
import random
import resource
import runpy
import sys
import time

import numpy as np
import torch

directory = Path(os.environ['V4_WORKER_TRACE'])
directory.mkdir(parents=True, exist_ok=True)
operation = sys.argv[1]
random.seed(0)
np.random.seed(0)
torch.manual_seed(0)
torch.set_num_threads(int(os.getenv('OMP_NUM_THREADS', '1')))
torch.set_num_interop_threads(1)
started = time.perf_counter()
events = []
counts = {}
arrays = {}


def write(name, value):
    (directory / name).write_text(json.dumps(value, ensure_ascii=False, indent=2))


def status(stage, **values):
    write('status.json', {'operation': operation, 'stage': stage, 'elapsedSeconds': time.perf_counter() - started, **values})


def word_list(values):
    return [asdict(value) for value in values]


if operation in {'align', 'transcribe', 'transcribe-many'}:
    from backend.ai_worker import ctc, speech

    original_asr = speech._accelerated_guidance
    asr_results = {}

    @wraps(original_asr)
    def asr(vocal, language, prompt, contexts=(), **options):
        source = {'shape': list(vocal.shape), 'dtype': str(vocal.dtype), 'sha256': sha256(vocal.tobytes()).hexdigest()} if isinstance(vocal, np.ndarray) else {'path': str(vocal), 'sha256': sha256(Path(vocal).read_bytes()).hexdigest()}
        request = {'source': source, 'language': language, 'prompt': prompt, 'contexts': contexts}
        key = sha256(json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        status('ASR', contexts=len(contexts), requestKey=key)
        begin = time.perf_counter()
        result = original_asr(vocal, language, prompt, contexts, **options)
        asr_results[key] = {'request': request, 'result': result}
        write('asr-cache.json', asr_results)
        events.append({'stage': 'ASR', 'elapsedSeconds': time.perf_counter() - begin, 'requestKey': key})
        return result

    speech._accelerated_guidance = asr

    if operation == 'align':
        original_evidence = speech._alignment_evidence
        signature = inspect.signature(original_evidence)

        @wraps(original_evidence)
        def evidence(*args, **kwargs):
            bound = signature.bind_partial(*args, **kwargs)
            write('alignment-input.json', {key: str(value) if isinstance(value, Path) else value for key, value in bound.arguments.items() if key in {'vocal', 'language', 'lyrics', 'recognition'}})
            arrays['audio'] = bound.arguments['samples']
            if bound.arguments.get('instrumental') is not None:
                arrays['instrumental'] = bound.arguments['instrumental']
            begin = time.perf_counter()
            result = original_evidence(*args, **kwargs)
            scores, step, heard = result
            arrays['scores'] = scores.detach().cpu().numpy()
            arrays['frame_seconds'] = np.array(step)
            np.savez_compressed(directory / 'acoustic-cache.npz', **arrays)
            write('alignment-evidence.json', {'heard': heard, 'independentViews': bound.arguments.get('independent_views', []), 'frameSeconds': step})
            events.append({'stage': 'alignment_evidence', 'elapsedSeconds': time.perf_counter() - begin})
            status('CTC/refinement')
            return result

        speech._alignment_evidence = evidence

        def trace(module, name, detailed=False):
            original = getattr(module, name)
            label = f'{module.__name__.rsplit(".", 1)[-1]}.{name}'

            @wraps(original)
            def call(*args, **kwargs):
                counts[label] = counts.get(label, 0) + 1
                before = word_list(args[0]) if detailed and args and isinstance(args[0], list) and args[0] and isinstance(args[0][0], ctc.AlignedWord) else None
                begin = time.perf_counter()
                result = original(*args, **kwargs)
                if detailed:
                    row = {'stage': label, 'elapsedSeconds': time.perf_counter() - begin}
                    if before is not None:
                        row['inputWords'] = before
                    if isinstance(result, list) and result and isinstance(result[0], ctc.AlignedWord):
                        row['outputWords'] = word_list(result)
                    events.append(row)
                if name in {'singing_frames', 'voiced_frames', 'vocal_onsets'}:
                    arrays[name] = result
                return result

            setattr(module, name, call)

        for name in ('align_words', 'align_guided', 'with_word_guidance', 'with_voice_onsets', 'with_sung_ends', 'ordered', 'with_sung_letters'):
            trace(speech, name, detailed=True)
        for name in ('singing_frames', 'voiced_frames', 'vocal_onsets'):
            trace(speech, name)
        trace(ctc, '_align_window')
        trace(ctc, 'ordered')

status('starting')
try:
    runpy.run_module('backend.ai_worker', run_name='__main__')
except SystemExit as result:
    code = result.code or 0
    status('completed' if code == 0 else 'failed', exitCode=code)
    raise
finally:
    if arrays:
        np.savez_compressed(directory / 'acoustic-cache.npz', **arrays)
    write('trace.json', {'operation': operation, 'argv': sys.argv[1:], 'seed': 0, 'threads': torch.get_num_threads(), 'elapsedSeconds': time.perf_counter() - started, 'maxRssKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, 'counts': counts, 'events': events})
