"""Run production alignment with hash-verified recorded model evidence only."""
from __future__ import annotations

from copy import deepcopy
from functools import lru_cache, wraps
from hashlib import sha256
import json
import os
from pathlib import Path
import runpy
import sys

import numpy as np
import torch

from backend.ai_worker import ctc, speech

assert sys.argv[1] == 'align', 'Only alignment executes a worker in model-replay mode'
cache = Path(os.environ['V4_ALIGNMENT_CACHE'])
output = Path(os.environ['V4_WORKER_TRACE'])
output.mkdir(parents=True, exist_ok=True)
with np.load(cache / 'acoustic-cache.npz') as data:
    arrays = {name: data[name].copy() for name in data.files}
recorded_asr = json.loads((cache / 'asr-cache.json').read_text())
misses = []
hits = []


def source(value):
    if isinstance(value, np.ndarray):
        return {'shape': list(value.shape), 'dtype': str(value.dtype), 'sha256': sha256(value.tobytes()).hexdigest()}
    return {'sha256': sha256(Path(value).read_bytes()).hexdigest()}


def canonical(request):
    value = deepcopy(request)
    value['source'].pop('path', None)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


requests = {canonical(record['request']): record for record in recorded_asr.values()}


def no_model(*args, **kwargs):
    misses.append({'kind': 'unexpected_model_load'})
    raise RuntimeError('Fresh model loading is prohibited in a matched-cache benchmark')


@lru_cache(maxsize=1)
def no_alignment_model():
    return no_model()


@wraps(speech._accelerated_guidance)
def asr(vocal, language, prompt, contexts=(), **options):
    request = {'source': source(vocal), 'language': language, 'prompt': prompt, 'contexts': contexts}
    key = canonical(request)
    if key not in requests:
        misses.append({'kind': 'ASR', 'request': request})
        (output / 'uncached-asr-requests.json').write_text(json.dumps(misses, ensure_ascii=False, indent=2))
        raise RuntimeError('Uncached independent ASR context; obtain fresh local evidence separately')
    hits.append({'kind': 'ASR', 'requestSha256': sha256(key.encode()).hexdigest(), 'contexts': len(contexts)})
    return deepcopy(requests[key]['result'])


@wraps(speech.emission)
def emission(samples):
    assert np.array_equal(samples, arrays['audio']), 'CTC audio differs from the recorded inference'
    hits.append({'kind': 'MMS', 'audioSha256': sha256(samples.tobytes()).hexdigest()})
    return torch.from_numpy(arrays['scores'].copy()), float(arrays['frame_seconds'])


speech._speech_model = no_model
speech.alignment_model = no_alignment_model
ctc._model = no_alignment_model
speech._accelerated_guidance = asr
speech.emission = emission
try:
    runpy.run_path(str(Path(__file__).with_name('trace_worker.py')), run_name='__main__')
finally:
    (output / 'model-replay.json').write_text(json.dumps({'cache': str(cache), 'hits': hits, 'misses': misses, 'freshModelCalls': 0}, ensure_ascii=False, indent=2))
    if misses:
        # Production may catch an ASR failure and keep older boundaries. Such a
        # run must still fail this benchmark instead of appearing fully cached.
        raise SystemExit(3)
