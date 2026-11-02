"""Run unchanged frontend gates separately so a known Vitest failure cannot hide Node tests."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

root = Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/frontend')
output = Path('/tmp/karaoke-sync-v2/frontend-checks')
output.mkdir(exist_ok=True)
def hashes():
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for folder in ('src', 'electron', 'scripts')
            for p in sorted((root / folder).rglob('*')) if p.is_file()}
before = hashes()
summary = {'sourceHashesBefore': before, 'checks': {}}
commands = {
    'typecheck': ['npm', 'run', 'typecheck'],
    'npm-test': ['npm', 'test'],
    'node-tests': ['node', '--test', 'electron/*.test.mjs', 'scripts/*.test.mjs'],
}
for name, command in commands.items():
    started = time.perf_counter()
    with (output / (name + '.log')).open('w') as stream:
        completed = subprocess.run(command, cwd=root, stdout=stream, stderr=subprocess.STDOUT,
                                   env={**os.environ, 'CI': '1'})
    summary['checks'][name] = {'command': command, 'exitCode': completed.returncode,
                              'seconds': time.perf_counter() - started}
    (output / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(name, completed.returncode, flush=True)
summary['sourceHashesAfter'] = hashes()
summary['sourceUnchanged'] = summary['sourceHashesAfter'] == before
(output / 'summary.json').write_text(json.dumps(summary, indent=2))
raise SystemExit(int(any(c['exitCode'] for c in summary['checks'].values()) or not summary['sourceUnchanged']))
