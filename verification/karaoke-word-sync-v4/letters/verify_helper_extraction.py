from __future__ import annotations

import importlib.util
import json
import hashlib
import sys
from dataclasses import asdict
from pathlib import Path

import numpy as np
import torch

REPO = Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct')
ROOT = Path('/tmp/karaoke-sync-v4')
sys.path.insert(0, str(REPO / 'python'))
from backend.ai_worker import ctc, recognition, timing

torch.set_num_threads(1)
snapshot = ROOT / 'letters/ctc-before-helper-extraction.py'
spec = importlib.util.spec_from_file_location('ctc_before_helper_extraction', snapshot)
before = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = before
spec.loader.exec_module(before)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def execute(module, words, scores, step, activity, heard):
    inputs = [module.AlignedWord(**(word | {'letters': tuple(word['letters']),
                                         'diagnostics': tuple(word['diagnostics'])}))
              for word in words]
    calls = []
    original = module.align_words

    def counted(crop, stride, texts, offset, **options):
        calls.append({'shape': list(crop.shape), 'stride': stride, 'texts': texts,
                      'offset': offset, **options})
        return original(crop, stride, texts, offset, **options)

    module.align_words = counted
    try:
        result = module.with_sung_letters(inputs, scores, step, activity, heard)
    finally:
        module.align_words = original
    return [asdict(word) for word in result], calls


rows = []
for path in sorted((ROOT / 'gtsinger-final').glob('*/stages.json')):
    stage = next(item for item in json.loads(path.read_text())
                 if item.get('stage') == 'speech.with_sung_letters')
    words = stage['inputWords']
    evidence = json.loads(path.with_name('alignment-evidence.json').read_text())
    aligned = [ctc.AlignedWord(**(word | {'letters': tuple(word['letters']),
                                        'diagnostics': tuple(word['diagnostics'])}))
               for word in words]
    heard = recognition.independent_timings(
        [word.text for word in aligned],
        [evidence['heard'], *evidence['independentViews']], aligned)
    with np.load(path.with_name('acoustic-cache.npz')) as cache:
        scores = torch.from_numpy(cache['scores'])
        step = float(cache['frame_seconds'])
        activity = cache['singing_frames']
    old, old_calls = execute(before, words, scores, step, activity, heard)
    new, new_calls = execute(ctc, words, scores, step, activity, heard)
    assert canonical(new) == canonical(old), path.parent.name
    assert new_calls == old_calls, path.parent.name
    assert canonical(new) == canonical(stage['outputWords']), (path.parent.name, 'frozen stage')
    rows.append({'case': path.parent.name, 'words': len(words), 'exactFrozenStageMatch': True,
                 'exactPreExtractionMatch': True, 'ctcCallsUnchanged': old_calls,
                 'outputSha256': hashlib.sha256(canonical(new).encode()).hexdigest(),
                 'output': new})

with np.load(REPO / 'python/tests/fixtures/wildways-verse-entry.npz') as cache:
    scores = torch.from_numpy(cache['clean_entry_scores'])
    samples = cache['clean_entry_vocal'].astype(np.float32)
    backing = cache['clean_entry_instrumental'].astype(np.float32)
activity = timing.singing_frames(samples, backing, 16000, 160)
word = ctc.AlignedWord('один', 8.62, 9.94, (8.62, 9.36, 9.38, 9.40), .0019060261965933023)
heard = {0: (8.62, 9.94)}
old, old_calls = execute(before, [asdict(word)], scores, .02, activity, heard)
new, new_calls = execute(ctc, [asdict(word)], scores, .02, activity, heard)
assert canonical(new) == canonical(old)
assert new_calls == old_calls
payload = recognition.alignment_payload([ctc.AlignedWord(**item) for item in new], heard)
old_payload = recognition.alignment_payload([ctc.AlignedWord(**item) for item in old], heard)
assert canonical(payload) == canonical(old_payload)
report = {'beforeSourceSha256': hashlib.sha256(snapshot.read_bytes()).hexdigest(),
          'afterSourceSha256': hashlib.sha256(Path(ctc.__file__).read_bytes()).hexdigest(),
          'gtsCases': rows, 'odin': {'exactPreExtractionMatch': True,
                                   'ctcCallsUnchanged': old_calls,
                                   'payload': payload,
                                   'payloadSha256': hashlib.sha256(canonical(payload).encode()).hexdigest()}}
target = ROOT / 'letters/helper-extraction-equality.json'
target.write_text(json.dumps(report, ensure_ascii=False, indent=2))
print('Exact matches:', len(rows), 'GTSinger cases;', sum(row['words'] for row in rows),
      'GTSinger words; Odin full payload; identical CTC calls')
print(target)
