"""Fresh cached real-audio proof, without ASR/MMS or pitch model inference."""
from pathlib import Path
from hashlib import sha256
from datetime import datetime, timezone
import json
import os
import subprocess
import time

repo = Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct')
out = Path('/tmp/karaoke-sync-v3/real-audio')
python = '/workspace/scratch/513dbcd967bf/runtime/venv/bin/python'
old = Path('/tmp/karaoke-sync-v2')
sources = [repo / 'python/backend/ai_worker' / (name + '.py') for name in ('ctc', 'speech', 'timing', 'recognition', 'word_guidance')]
def hashes(paths):
    return {str(p): sha256(p.read_bytes()).hexdigest() for p in paths}
jobs = [
    ('final-clean-paired', [python, str(old / 'odin/clean_replay.py'), '--repo', str(repo), '--out', str(out / 'final-clean-paired.json'), '--local-asr', '--label', 'v3 final backend, exact paired clean_entry']),
    ('final-uncertain-related', [python, str(old / 'odin/clean_replay.py'), '--repo', str(repo), '--out', str(out / 'final-uncertain-related.json'), '--uncertain-related', '--label', 'v3 final backend, uncertain emissions on related waveform; not exact source']),
    ('final-sadvit', [python, str(old / 'real-audio/replay_sadvit.py'), str(repo / 'python'), str(out / 'final-sadvit.json'), '--label', 'v3 final backend, actual SadSvit excerpts']),
]
environment = dict(os.environ, OMP_NUM_THREADS='1', MKL_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', NUMBA_CACHE_DIR='/tmp/karaoke-numba-cache')
report = {'startedUtc': datetime.now(timezone.utc).isoformat(), 'sourceHashesBefore': hashes(sources), 'scope': 'Fresh cached-input real-fragment replays; no ASR/MMS/new pitch inference. Existing singing mask model may run inside waveform postprocessing. Execution times are not full-pipeline or comparative performance results.', 'commands': []}
for name, command in jobs:
    start = time.monotonic()
    with (out / (name + '.log')).open('w') as log:
        process = subprocess.run(command, cwd=repo, env=environment, stdout=log, stderr=subprocess.STDOUT)
    report['commands'].append({'name': name, 'argv': command, 'scriptSha256': sha256(Path(command[1]).read_bytes()).hexdigest(), 'exitCode': process.returncode, 'elapsedSeconds': time.monotonic() - start, 'log': str(out / (name + '.log'))})
    (out / 'fresh-replay-execution.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(name, 'exit', process.returncode, flush=True)
report['sourceHashesAfter'] = hashes(sources)
report['sourcesUnchanged'] = report['sourceHashesBefore'] == report['sourceHashesAfter']
report['finishedUtc'] = datetime.now(timezone.utc).isoformat()
(out / 'fresh-replay-execution.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
raise SystemExit(any(row['exitCode'] != 0 for row in report['commands']))
