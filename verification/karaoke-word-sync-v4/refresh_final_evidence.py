"""Replay frozen cached evidence only, reusing the identically run onset case."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path('/tmp/karaoke-sync-v4')
BASE = ROOT / 'gtsinger-baseline'
OUT = ROOT / 'gtsinger-final'
OLD = ROOT / 'gtsinger-before-freeze3'
REPO = Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct')
PYTHON = '/workspace/scratch/513dbcd967bf/runtime/venv/bin/python'
freeze_path = ROOT / 'source-freeze-final.json'
freeze = json.loads(freeze_path.read_text())
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

env = os.environ.copy()
env.update(AD_VOICE_MODELS='/workspace/scratch/513dbcd967bf/runtime/models-v4',
           AD_VOICE_COMPUTE_DEVICE='cpu', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2',
           OPENBLAS_NUM_THREADS='1', NUMBA_CACHE_DIR='/tmp/karaoke-numba-cache')
results = []
for manifest in ('inference-inputs.json', 'additional-inference-inputs.json'):
    data = json.loads((BASE / manifest).read_text())
    for case in data['cases'] if isinstance(data, dict) else data:
        name = case['case']
        target = OUT / name
        checkpoint = OLD / name
        checkpoint.mkdir(parents=True, exist_ok=True)
        for filename in ('metadata.json', 'payload.json', 'stages.json'):
            if not (checkpoint / filename).exists():
                shutil.copy2(target / filename, checkpoint / filename)
        started = time.perf_counter()
        if name == 'control_0003':
            source = ROOT / 'onset-anchor-final' / name
            metadata = json.loads((source / 'metadata.json').read_text())
            assert metadata['completed'] and metadata['sourceHashesUnchanged']
            assert metadata['audioHashUnchanged'] and not metadata['referenceLabelsPassedToModels']
            for entry in freeze['files']:
                relative = entry['path'].removeprefix('python/')
                if relative.startswith('backend/'):
                    assert metadata['sourceHashes'][relative] == entry['sha256']
            for filename in ('metadata.json', 'payload.json', 'stages.json', 'asr-cache.json',
                             'acoustic-cache.npz', 'alignment-evidence.json'):
                shutil.copy2(source / filename, target / filename)
            result = {'case': name, 'exitCode': 0, 'reusedIdenticalHarnessExecution': str(source),
                      'startedUtc': metadata['startedUtc'], 'finishedUtc': metadata['finishedUtc'],
                      'seconds': metadata['elapsedSeconds']}
        else:
            command = [PYTHON, str(BASE / 'run_alignment.py'), '--repo-python', str(REPO / 'python'),
                       '--inputs', str(BASE / manifest), '--case', name, '--output', str(target),
                       '--cache-from', str(BASE / name)]
            with (OUT / (name + '.log')).open('w') as log:
                completed = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT)
            result = {'case': name, 'exitCode': completed.returncode, 'seconds': time.perf_counter() - started}
            assert completed.returncode == 0, result
        results.append(result)
        print(json.dumps(result), flush=True)

for entry in freeze['files']:
    assert sha(REPO / entry['path']) == entry['sha256'], entry['path']
(OUT / 'executions.json').write_text(json.dumps(results, indent=2) + '\n')
(OUT / 'freeze3-replay-provenance.json').write_text(json.dumps({
    'completedUtc': datetime.now(timezone.utc).isoformat(),
    'sourceFreezeSha256': sha(freeze_path), 'scriptSha256': sha(Path(__file__)),
    'mode': 'Cached ASR/CTC evidence only; no new model inference; all six final source hashes checked.',
    'executions': results,
}, indent=2) + '\n')
