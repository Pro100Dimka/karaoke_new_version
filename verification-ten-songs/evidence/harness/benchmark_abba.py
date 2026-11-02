"""Run cached alignment A/B/B/A in separate processes; never splice product functions.

This measures production alignment on the same frozen evidence, not decoding,
ASR/MMS, separation, pitch inference or full-song processing. Run only after the
single heavy inference worker has finished and both reference traces are final.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def backend_hashes(directory):
    return {str(p.relative_to(directory)): sha(p) for p in sorted((directory / 'backend').rglob('*.py'))}


def dump(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.pending')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def summarize(records, reports, cases):
    rows = []
    for name in cases:
        versions = {}
        for version in ('baseline', 'final'):
            selected = [(record, next(c for c in report['cases'] if c['case'] == name))
                        for record, report in zip(records, reports, strict=True) if record['version'] == version]
            wall = [value for _, case in selected for value in case['wallRunsMs']]
            cpu = [value for _, case in selected for value in case['cpuRunsMs']]
            versions[version] = {'medianWallMs': statistics.median(wall),
                'medianCpuMs': statistics.median(cpu), 'minimumWallMs': min(wall), 'maximumWallMs': max(wall),
                'measurementCount': len(wall),
                'blockMedians': [{'block': record['block'], 'cycle': record['cycle'],
                    'wallMs': case['medianWallMs'], 'cpuMs': case['medianCpuMs']} for record, case in selected],
                'allOutputsEqualReference': all(c['exactReferenceOutputForEveryRun'] for _, c in selected),
                'allInputsUnchanged': all(c['inputsUnchanged'] for _, c in selected),
                'modelCalls': sum(c['modelCalls'] for _, c in selected)}
        before, after = versions['baseline']['medianWallMs'], versions['final']['medianWallMs']
        rows.append({'case': name, **versions, 'finalMinusBaselineWallMs': after - before,
                     'wallChangePercent': 100 * (after / before - 1) if before > 0 else None})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-python', type=Path, required=True)
    parser.add_argument('--final-python', type=Path, required=True)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--baseline-reference', type=Path, required=True)
    parser.add_argument('--final-reference', type=Path, required=True)
    parser.add_argument('--python', type=Path, default=Path(sys.executable))
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--case', action='append')
    parser.add_argument('--cycles', type=int, default=1)
    parser.add_argument('--warmups', type=int, default=3)
    parser.add_argument('--iterations', type=int, default=9)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if args.cycles < 1 or args.warmups < 1 or args.iterations < 3:
        parser.error('Require cycles>=1, warmups>=1, iterations>=3')
    cases = [c['case'] for c in json.loads(args.inputs.read_text())['cases']]
    if args.case:
        if not set(args.case) <= set(cases):
            parser.error('Unknown selected case')
        cases = [c for c in cases if c in args.case]
    if not cases or len(cases) != len(set(cases)):
        parser.error('Require a nonempty unique set of cases')
    repos = {'baseline': args.baseline_python.resolve(), 'final': args.final_python.resolve()}
    references = {'baseline': args.baseline_reference.resolve(), 'final': args.final_reference.resolve()}
    source_hashes = {v: backend_hashes(p) for v, p in repos.items()}
    if any(not h for h in source_hashes.values()):
        parser.error('Both --*-python paths must contain backend Python sources')
    worker = Path(__file__).with_name('benchmark_cached_alignment.py').resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    artifacts = []
    for case in cases:
        artifacts.extend(args.evidence_dir / case / name for name in
                         ('metadata.json', 'acoustic-cache.npz', 'alignment-evidence.json', 'asr-cache.json'))
        artifacts.extend(directory / case / name for directory in references.values()
                         for name in ('metadata.json', 'payload.json'))
    frozen_files = {str(path.resolve()): sha(path) for path in artifacts}
    identity = {'runnerSha256': sha(__file__), 'workerPath': str(worker), 'workerSha256': sha(worker),
        'python': str(args.python.resolve()), 'inputsPath': str(args.inputs.resolve()),
        'inputsSha256': sha(args.inputs), 'evidenceDirectory': str(args.evidence_dir.resolve()),
        'repositories': {v: str(p) for v, p in repos.items()},
        'referenceDirectories': {v: str(p) for v, p in references.items()},
        'sourceHashes': source_hashes, 'frozenEvidenceAndReferenceFiles': frozen_files,
        'cases': cases, 'cycles': args.cycles,
        'warmups': args.warmups, 'iterationsPerBlock': args.iterations}
    changed = sorted(name for name in source_hashes['baseline'].keys() | source_hashes['final'].keys()
                     if source_hashes['baseline'].get(name) != source_hashes['final'].get(name))
    blocks = []
    for cycle in range(args.cycles):
        for order, version in enumerate(('baseline', 'final', 'final', 'baseline')):
            label = f'cycle-{cycle + 1:02d}-{order + 1}-{version}'
            output = args.output_dir / (label + '.json')
            command = [str(args.python), str(worker), '--repo-python', str(repos[version]),
                '--inputs', str(args.inputs), '--evidence-dir', str(args.evidence_dir),
                '--reference-dir', str(references[version]), '--warmups', str(args.warmups),
                '--iterations', str(args.iterations), '--output', str(output)]
            for case in cases:
                command.extend(('--case', case))
            blocks.append({'block': label, 'cycle': cycle + 1, 'order': order + 1, 'version': version,
                'command': command, 'output': str(output), 'log': str(output.with_suffix('.log'))})
    plan = {'scope': __doc__, 'identity': identity, 'changedBackendFiles': changed, 'blocks': blocks,
        'execution': 'Sequential independent processes in A/B/B/A order, unchanged case order per block; one Torch thread inside the existing worker. No AST/function selector.'}
    plan_path = args.output_dir / 'plan.json'
    if plan_path.exists() and json.loads(plan_path.read_text()) != plan:
        parser.error('Changed plan; preserve previous evidence and use a new output directory')
    dump(plan_path, plan)
    if args.dry_run:
        print(json.dumps({'dryRun': True, 'processesNotStarted': len(blocks), 'cases': cases,
            'changedBackendFiles': changed, 'plan': str(plan_path)}, ensure_ascii=False))
        return
    records_path = args.output_dir / 'executions.json'
    state = json.loads(records_path.read_text()) if records_path.exists() else {
        'identity': identity, 'startedUtc': datetime.now(timezone.utc).isoformat(), 'completed': False, 'records': []}
    if state['identity'] != identity:
        parser.error('Changed execution identity; use a new output directory')
    reports = []
    for index, block in enumerate(blocks):
        assert sha(args.inputs) == identity['inputsSha256'] and sha(worker) == identity['workerSha256']
        assert {v: backend_hashes(p) for v, p in repos.items()} == source_hashes
        assert {path: sha(path) for path in frozen_files} == frozen_files
        output = Path(block['output'])
        if index < len(state['records']):
            record = state['records'][index]
            assert record['block'] == block['block'] and record['exitCode'] == 0
            assert sha(output) == record['outputSha256']
        else:
            if output.exists() or Path(block['log']).exists():
                raise RuntimeError(f'Unverified/incomplete block: preserve it and use a new output directory: {output}')
            print(json.dumps({'block': block['block'], 'status': 'started'}), flush=True)
            started = time.perf_counter()
            with Path(block['log']).open('w') as log:
                code = subprocess.run(block['command'], stdout=log, stderr=subprocess.STDOUT,
                                      env=os.environ.copy()).returncode
            record = {**block, 'exitCode': code, 'processWallSecondsIncludingStartup': time.perf_counter() - started,
                'outputSha256': sha(output) if output.exists() else None}
            state['records'].append(record)
            dump(records_path, state)
            if code:
                raise SystemExit(f"Cached benchmark failed ({code}); see {block['log']}")
        report = json.loads(output.read_text())
        assert report['completed'] and report['inputManifestSha256'] == identity['inputsSha256']
        assert report['scriptSha256'] == identity['workerSha256']
        assert report['sourceHashesBefore'] == report['sourceHashesAfter'] == source_hashes[block['version']]
        assert [c['case'] for c in report['cases']] == cases
        assert report['torchThreads'] == 1
        assert all(c['exactReferenceOutputForEveryRun'] and c['inputsUnchanged']
                   and c['modelCalls'] == 0 and not c['cacheMisses'] for c in report['cases'])
        assert {path: sha(path) for path in frozen_files} == frozen_files
        for case in report['cases']:
            reference = references[block['version']] / case['case'] / 'payload.json'
            assert case['referencePayloadSha256'] == frozen_files[str(reference.resolve())]
            for name, digest in case['cacheFileHashes'].items():
                source = args.evidence_dir / case['case'] / name
                assert digest == frozen_files[str(source.resolve())]
        reports.append(report)
        print(json.dumps({'block': block['block'], 'status': 'verified'}), flush=True)
    state.update(completed=True, finishedUtc=datetime.now(timezone.utc).isoformat())
    dump(records_path, state)
    summary = {'scope': __doc__, 'completed': True, 'identity': identity, 'changedBackendFiles': changed,
        'order': ['baseline', 'final', 'final', 'baseline'] * args.cycles,
        'timingExclusions': reports[0]['timingExclusions'],
        'cases': summarize(state['records'], reports, cases), 'executionReport': str(records_path)}
    dump(args.output_dir / 'summary.json', summary)
    print(json.dumps({'summary': str(args.output_dir / 'summary.json'),
                      'cases': [{k: c[k] for k in ('case', 'wallChangePercent')} for c in summary['cases']]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
