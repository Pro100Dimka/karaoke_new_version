"""Read-only paired replay of the three new full-suite recording outcomes.

No test expectations, application sources, or scheduler behavior are changed.
Both checkouts use exactly the same test node IDs, Python executable, and env.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

BASE = Path('/workspace/scratch/513dbcd967bf')
ROOTS = {
    'baseline-v1': BASE / 'baseline-v1/karaoke_new_version-refactor-frontend-direct/python',
    'current': BASE / 'project/karaoke_new_version-refactor-frontend-direct/python',
}
NODES = [
    'tests/test_recordings_analysis.py::test_recording_name_and_status_are_backend_authoritative',
    'tests/test_recordings_analysis.py::test_studio_master_creates_a_separate_adaptively_balanced_recording',
    'tests/test_recordings_analysis.py::test_studio_master_keeps_the_recorded_balance_wet_effects_and_take_duration[effects]',
]


def hashes(root):
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for folder in ('backend', 'tests', 'scripts')
        for p in sorted((root / folder).rglob('*.py'))
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--order', nargs='+', choices=ROOTS, default=['baseline-v1', 'current'])
    args = ap.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    env_changes = {name: '1' for name in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMBA_NUM_THREADS')}
    env_changes['NUMBA_CACHE_DIR'] = '/tmp/karaoke-numba-cache'
    env = {**os.environ, **env_changes}
    report = {'scope': 'Three identical unmodified test nodes, sequential independent pytest processes',
              'nodes': NODES, 'environmentOverrides': env_changes, 'runs': []}
    for index, label in enumerate(args.order):
        root = ROOTS[label]
        prefix = f'{index + 1}-{label}'
        log = args.output / f'{prefix}.log'
        xml = args.output / f'{prefix}.xml'
        before = hashes(root)
        command = [sys.executable, '-m', 'pytest', '-q', '--tb=short', '-rA', f'--junitxml={xml}', *NODES]
        started = time.perf_counter()
        with log.open('w') as stream:
            result = subprocess.run(command, cwd=root, env=env, stdout=stream, stderr=subprocess.STDOUT)
        after = hashes(root)
        testcases = []
        if xml.exists():
            for case in ET.parse(xml).iter('testcase'):
                failure = case.find('failure')
                error = case.find('error')
                skipped = case.find('skipped')
                testcases.append({'name': case.attrib['name'], 'class': case.attrib.get('classname'),
                                  'outcome': 'failed' if failure is not None else 'error' if error is not None else 'skipped' if skipped is not None else 'passed',
                                  'evidence': failure.text if failure is not None else error.text if error is not None else None})
        row = {'label': label, 'root': str(root), 'command': command, 'log': str(log),
               'exitCode': result.returncode, 'seconds': time.perf_counter() - started,
               'sourceUnchanged': before == after, 'sourceHashesBefore': before, 'sourceHashesAfter': after,
               'summary': next((line for line in reversed(log.read_text().splitlines()) if re.search(r'\b(?:passed|failed|error|skipped)\b.*\bin\s+[\d.]+s', line)), None),
               'testcases': testcases}
        report['runs'].append(row)
        (args.output / 'paired-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({k: row[k] for k in ('label', 'exitCode', 'seconds', 'sourceUnchanged', 'summary', 'testcases')}, ensure_ascii=False), flush=True)
    return int(any(r['exitCode'] or not r['sourceUnchanged'] for r in report['runs']))


if __name__ == '__main__':
    raise SystemExit(main())
