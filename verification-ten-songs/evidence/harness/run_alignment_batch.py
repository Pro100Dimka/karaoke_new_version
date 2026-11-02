"""Sequentially invoke the existing tracing harness; never silently refresh a replay."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo-python', type=Path, required=True)
parser.add_argument('--inputs', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--cache-from', type=Path)
parser.add_argument('--case', action='append')
args = parser.parse_args()
cases = json.loads(args.inputs.read_text())['cases']
if args.case:
    assert set(args.case) <= {c['case'] for c in cases}
    cases = [c for c in cases if c['case'] in args.case]
args.output.mkdir(parents=True, exist_ok=True)
source_hashes = {str(p.relative_to(args.repo_python)): sha(p)
                 for p in sorted((args.repo_python / 'backend').rglob('*.py'))}
records = []
for case in cases:
    target = args.output / case['case']
    marker = target / 'metadata.json'
    if marker.exists():
        previous = json.loads(marker.read_text())
        assert previous.get('completed') is True, f'Incomplete run: preserve it and choose a new output root: {target}'
        assert previous['inputs'] == case
        assert previous['sourceHashes'] == source_hashes
        assert previous['sourceHashesUnchanged'] and previous['audioHashUnchanged']
        assert (target / 'payload.json').is_file()
        print(json.dumps({'case': case['case'], 'status': 'reused-verified-complete-run'}), flush=True)
        continue
    command = [sys.executable, str(Path(__file__).with_name('run_alignment.py')),
               '--repo-python', str(args.repo_python), '--inputs', str(args.inputs),
               '--case', case['case'], '--output', str(target)]
    if args.cache_from:
        command += ['--cache-from', str(args.cache_from / case['case'])]
    print(json.dumps({'case': case['case'], 'status': 'started', 'replay': bool(args.cache_from)}), flush=True)
    started = time.perf_counter()
    with (args.output / (case['case'] + '.log')).open('w') as log:
        code = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT).returncode
    records.append({'case': case['case'], 'command': command, 'exitCode': code,
                    'wallSeconds': time.perf_counter() - started})
    (args.output / 'executions.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(records[-1]), flush=True)
    if code:
        raise SystemExit(code)
    assert source_hashes == {n: sha(args.repo_python / n) for n in source_hashes}
