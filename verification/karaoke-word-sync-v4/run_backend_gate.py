from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python')
OUT = Path('/tmp/karaoke-sync-v4/backend-checks')
PREVIOUS = Path('/tmp/karaoke-sync-v3/backend-checks')
OUT.mkdir(parents=True, exist_ok=True)
old = json.loads((PREVIOUS / 'summary.json').read_text())
checks = {name: entry['command'] for name, entry in old['checks'].items()}
assert checks['pytest'] == [sys.executable, '-m', 'pytest', '-q', '--tb=short']


def hashes():
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for folder in ('backend', 'tests', 'scripts')
            for p in sorted((ROOT / folder).rglob('*.py'))}


env = dict(os.environ, OMP_NUM_THREADS='1', MKL_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1',
           NUMBA_CACHE_DIR='/tmp/karaoke-numba-cache')
summary = {'python': sys.version, 'platform': sys.platform,
           'startedAt': datetime.now(timezone.utc).isoformat(), 'cwd': str(ROOT),
           'scope': 'Exact ordered backend gate commands, including all pytest; no suppressed failures.',
           'reusedCommandsFrom': str(PREVIOUS / 'summary.json'),
           'environment': {k: env[k] for k in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS',
                                             'OPENBLAS_NUM_THREADS', 'NUMBA_CACHE_DIR')},
           'versions': {p: importlib.metadata.version(p) for p in
                        ('torch', 'torchaudio', 'numpy', 'scipy', 'librosa', 'pytest', 'ruff', 'mypy')},
           'source_hashes_before': hashes(), 'checks': {}}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2))
for name, command in checks.items():
    print(f'Starting {name}', flush=True)
    start = time.perf_counter()
    with (OUT / f'{name}.log').open('w') as log:
        result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    summary['checks'][name] = {'command': command, 'exit_code': result.returncode,
                               'seconds': round(time.perf_counter() - start, 3)}
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(name, summary['checks'][name], flush=True)
summary['source_hashes_after'] = hashes()
summary['sourceUnchanged'] = summary['source_hashes_before'] == summary['source_hashes_after']
summary['finishedAt'] = datetime.now(timezone.utc).isoformat()
summary['runnerExitCode'] = int(any(c['exit_code'] for c in summary['checks'].values())
                                or not summary['sourceUnchanged'])
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2))
log = (OUT / 'pytest.log').read_text()
failure_ids = re.findall(r'^FAILED (\S+)', log, re.M)
previous_ids = set(json.loads((PREVIOUS / 'result.json').read_text())['failureIDs'])
pytest_summary = next((line for line in reversed(log.splitlines())
                       if re.search(r'\b\d+ (?:failed|passed)', line)), None)
result = {'runnerExitCode': summary['runnerExitCode'], 'pytestSummary': pytest_summary,
          'sourceUnchanged': summary['sourceUnchanged'], 'checks': summary['checks'],
          'failureCount': len(failure_ids), 'failureIDs': failure_ids,
          'newFailureIDsAgainstV3': sorted(set(failure_ids) - previous_ids),
          'v3FailuresAbsentFromThisRun': sorted(previous_ids - set(failure_ids))}
(OUT / 'result.json').write_text(json.dumps(result, indent=2))
(OUT / 'failure-ids.txt').write_text('\n'.join(failure_ids) + '\n')
print(json.dumps({k: v for k, v in result.items() if k not in ('checks', 'failureIDs')}, indent=2), flush=True)
raise SystemExit(summary['runnerExitCode'])
