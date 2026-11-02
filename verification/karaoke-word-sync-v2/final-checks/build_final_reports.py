"""Compile immutable local gate, note, and excerpt evidence without running models/tests."""
from __future__ import annotations

from collections import Counter
import copy
import hashlib
import json
from pathlib import Path

BASE = Path('/workspace/scratch/513dbcd967bf')
ART = Path('/tmp/karaoke-sync-v2')
CURRENT = BASE / 'project/karaoke_new_version-refactor-frontend-direct/python'
BASELINE = BASE / 'baseline-v1/karaoke_new_version-refactor-frontend-direct/python'
OUT = ART / 'final-checks'


def read(path):
    return json.loads(path.read_text())


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def excerpt(path, start, end):
    lines = path.read_text().splitlines()
    return {'file': str(path), 'firstLine': start, 'lastLine': end,
            'text': '\n'.join(lines[start - 1:end])}


def new_outcomes():
    original = read(OUT / 'baseline-comparison.json')
    historical_folder = BASE / 'deliverables/verification/karaoke-word-sync/compatible-baseline'
    historical_summary = read(historical_folder / 'summary.json')
    runs = []
    for folder in ('new-outcome-pair', 'new-outcome-pair-reversed'):
        paired = read(OUT / folder / 'paired-results.json')
        for run in paired['runs']:
            runs.append({'pairFolder': folder, **{k: run[k] for k in (
                'label', 'command', 'exitCode', 'seconds', 'sourceUnchanged', 'summary', 'log', 'testcases'
            )}})
    source_files = [
        'tests/fakes.py', 'tests/conftest.py', 'tests/test_recordings_analysis.py',
        'backend/recordings/register_recording.py', 'backend/recordings/update_recording.py',
        'backend/recordings/start_studio_master.py', 'backend/api/recording_routes.py',
        'backend/bootstrap/build.py', 'backend/bootstrap/recording_wiring.py',
        'backend/processing/document_pipeline.py', 'backend/processing/job_manager.py',
        'backend/processing/algorithms.py', 'backend/lyrics/domain.py',
    ]
    source_rows = []
    for name in source_files:
        left, right = BASELINE / name, CURRENT / name
        source_rows.append({'file': name, 'baselineSha256': sha(left), 'currentSha256': sha(right),
                            'identical': left.read_bytes() == right.read_bytes(),
                            'historicalOriginalSha256': historical_summary['source_hashes_before'].get(name),
                            'historicalOriginalMatchesCurrent': historical_summary['source_hashes_before'].get(name) == sha(right)})
    results = []
    for node in original['newFailureIDs']:
        name = node.split('::')[-1]
        observations = [{'pairFolder': run['pairFolder'], 'label': run['label'],
                         **next(case for case in run['testcases'] if case['name'] == name)}
                        for run in runs]
        results.append({'nodeId': node,
                        'baselineFailureDirectlyReproduced': any(x['label'] == 'baseline-v1' and x['outcome'] == 'failed' for x in observations),
                        'currentOutcomesVaryAcrossIsolatedSamples': len({x['outcome'] for x in observations if x['label'] == 'current'}) > 1,
                        'observations': observations})
    report = {
        'scope': 'Exact three new final full-suite outcomes, two paired orders, no source or test expectation changes.',
        'newFailureOutcomes': results,
        'runs': runs,
        'unchangedRelevantSourceFiles': source_rows,
        'allListedSourcesIdenticalBetweenV1AndFinal': all(row['identical'] for row in source_rows),
        'historicalOriginalEvidence': {
            'qualification': 'Separate earlier original-source run; not the fresh v1 paired sample.',
            'log': str(historical_folder / 'pytest.log'), 'logSha256': sha(historical_folder / 'pytest.log'),
            'summary': str(historical_folder / 'summary.json'), 'summarySha256': sha(historical_folder / 'summary.json'),
            'sourceUnchangedDuringHistoricalRun': historical_summary['source_unchanged_during_checks'],
            'ctcSha256': historical_summary['source_hashes_before']['backend/ai_worker/ctc.py'],
            'nameStatusPreparingFailure': excerpt(historical_folder / 'pytest.log', 357, 363),
        },
        'staticEvidence': [
            excerpt(CURRENT / 'tests/fakes.py', 75, 98),
            excerpt(CURRENT / 'tests/test_recordings_analysis.py', 25, 64),
            excerpt(CURRENT / 'tests/test_recordings_analysis.py', 502, 534),
            excerpt(CURRENT / 'tests/test_recordings_analysis.py', 577, 588),
            excerpt(CURRENT / 'backend/recordings/register_recording.py', 79, 92),
            excerpt(CURRENT / 'backend/recordings/register_recording.py', 113, 129),
            excerpt(CURRENT / 'backend/recordings/register_recording.py', 145, 156),
            excerpt(CURRENT / 'backend/recordings/start_studio_master.py', 131, 140),
        ],
        'conclusions': [
            'studio-master creation 409 Recording is not finalized reproduces on unchanged v1 in both paired samples and on final in one sample.',
            'effects is failed then passed on unchanged final; it passed in both isolated v1 samples. Its baseline failure has NOT been directly reproduced.',
            'name/status is Preparing in the final full run and both isolated final samples, but passed in both isolated v1 samples. Its baseline failure has NOT been directly reproduced.',
            'The same name/status Preparing != Ready failure exists in the earlier compatible-baseline original-source log. This is historical pre-existing evidence, distinct from fresh v1 reproduction; its relevant source hashes are recorded separately.',
            'All three tests use FakeAiProvider.align, which returns a fixed WordTiming and does not invoke speech/CTC/word-guidance. Relevant test, registration, preparation, routing and pipeline files are byte-identical.',
            'The registration helper waits only for HTTP 201; production schedules background preparation and returns before the Ready transition. The next assertion/API call can observe Preparing. Studio mastering explicitly rejects non-Ready recordings.',
            'This static path evidence is separate from direct baseline failure reproduction. No full-suite failure is dismissed or removed from the remaining 60 IDs.',
        ],
    }
    save(OUT / 'new-outcome-evidence.json', report)
    return report


def classify_final(new_report):
    baseline = read(ART / 'baseline-checks/failure-classification.json')
    baseline_by_id = {row['nodeId']: row for row in baseline['failureRows']}
    blocks = read(OUT / 'failure-blocks.json')
    final_ids = (OUT / 'failure-ids.txt').read_text().splitlines()
    new_by_id = {row['nodeId']: row for row in new_report['newFailureOutcomes']}
    categories = {
        'test_recording_name_and_status_are_backend_authoritative': (
            'recording_preparation_status',
            'Renamed recording reports Preparing, while test immediately expects Ready after registration.',
            'Unchanged background preparation path and no-wait test helper confirmed. Failure repeated on final and present in historical original-source log, but not directly reproduced on isolated fresh v1.'),
        'test_studio_master_creates_a_separate_adaptively_balanced_recording': (
            'studio_master_preparation_conflict',
            'Studio master POST returns 409 StudioMasterUnavailable: Recording is not finalized, rather than 202.',
            'Same failure directly reproduced on v1 twice; final outcome varies across paired runs. Unchanged preparation readiness check is the immediate cause.'),
        'test_studio_master_keeps_the_recorded_balance_wet_effects_and_take_duration[effects]': (
            'studio_master_submission',
            'Studio master response lacks jobId; test fails before checking recorded effects.',
            'Response status/body omitted by original test. Outcome varies on unchanged final; not directly reproduced on isolated v1. Shares the unchanged background preparation path.'),
    }
    rows = []
    for node in final_ids:
        name = node.split('::')[-1]
        if node in baseline_by_id:
            row = copy.deepcopy(baseline_by_id[node])
            row['baselineImmediateCause'] = row['immediateCause']
            if name == 'test_locked_architecture_gates':
                row['immediateCause'] = 'Architecture checker returns 60 violations; final ctc.py has 721 lines against the 500-line limit (v1 had 718).'
            row['sharedWithFreshV1FailureSet'] = True
        else:
            category, cause, status = categories[name]
            row = {'nodeId': node, 'category': category, 'immediateCause': cause, 'rootCauseStatus': status,
                   'sourceEvidence': [str(CURRENT / 'tests/test_recordings_analysis.py'), str(CURRENT / 'tests/fakes.py'), str(CURRENT / 'backend/recordings/register_recording.py'), str(CURRENT / 'backend/recordings/start_studio_master.py')],
                   'relatedToTargetedWordRepair': False, 'sharedWithFreshV1FailureSet': False,
                   'pairedReplayEvidence': new_by_id[node]}
        row['finalLog'] = str(OUT / 'pytest.log')
        row['savedFinalLogEvidence'] = blocks[name].splitlines()
        rows.append(row)
    counts = dict(sorted(Counter(row['category'] for row in rows).items()))
    result = {
        'scope': 'Strict remaining failures from final frozen-source full backend gate. No failures ignored or waived.',
        'totalFailures': len(rows), 'counts': counts, 'failureRows': rows,
        'newOutcomeEvidence': str(OUT / 'new-outcome-evidence.json'),
        'baselineComparison': read(OUT / 'baseline-comparison.json'),
        'caveats': [
            'Full backend gate is red: architecture, format, mypy and pytest fail; compile, bootstrap and lint pass.',
            'Matching counts do not mean architecture diagnostics are byte-identical; changed source line counts are retained in logs.',
            'CUDA embedding failure is a mocked dtype assertion and cannot be explained away by missing GPU.',
            'Two CPU/CUDA execution-budget fixtures report total RAM 16000 bytes despite available RAM 16 GiB; resource admission fails before AI.',
            'Three new full-suite outcomes remain listed. Only one was directly reproduced as a v1 failure in the paired checks.',
            'Four non-target baseline failures absent from the final full run are outcome variation, not claimed fixes.',
        ],
    }
    save(OUT / 'failure-classification-final.json', result)
    lines = ['FINAL BACKEND GATE: NOT GREEN', '', '60 failed, 1247 passed, 6 skipped; runner exit 1.',
             'Compile/bootstrap/lint pass. Architecture 60 diagnostics; format 25 files; mypy 27 errors in 8 files.',
             '369 Python source hashes unchanged during final gate.', '', 'Remaining failure categories:']
    lines += [f'{category}: {count}' for category, count in counts.items()]
    lines += ['', 'Exact remaining IDs:'] + final_ids
    lines += ['', 'Three new outcome qualifications:'] + new_report['conclusions']
    (OUT / 'failure-classification-final.txt').write_text('\n'.join(lines) + '\n')
    return result


def sadvit_final():
    folder = ART / 'real-audio'
    before_path, after_path = folder / 'sadvit-baseline-v1.json', folder / 'sadvit-current-final.json'
    before, after = read(before_path), read(after_path)
    rows = []
    for left, right in zip(before['cases'], after['cases'], strict=True):
        assert left['case'] == right['case']
        rows.append({
            'case': left['case'], 'text': left['text'],
            'inputsIdentical': all(left.get(key) == right.get(key) for key in ('vocalSha256', 'instrumentalSha256', 'emissionSha256', 'offset', 'durationSeconds')),
            'rawCoreIdentical': left['rawCore'] == right['rawCore'],
            'finalWordLettersIdentical': left['final'] == right['final'],
            'rawAbsolute': left['rawAbsolute'], 'beforeFinalAbsolute': left['finalAbsolute'], 'afterFinalAbsolute': right['finalAbsolute'],
            'startChangeMs': 1000 * (right['finalAbsolute']['start'] - left['finalAbsolute']['start']),
            'endChangeMs': 1000 * (right['finalAbsolute']['end'] - left['finalAbsolute']['end']),
            'referenceEnd': left['endReferenceInterval'],
            'beforeEndDistanceToIntervalMs': round(left['finalEndVsAcousticInterval']['signedDistanceToIntervalMs'], 6),
            'afterEndDistanceToIntervalMs': round(right['finalEndVsAcousticInterval']['signedDistanceToIntervalMs'], 6),
            'startErrorMs': None,
            'interpretation': 'Unchanged. Endpoint distances describe uncertain acoustic brackets, not a certified manual release label. No improvement or precise timing error is claimed.',
        })
    result = {'scope': 'Final production cached real-excerpt replay paired with fixed v1; no new model inference.',
              'beforeFile': str(before_path), 'afterFile': str(after_path), 'beforeSha256': sha(before_path), 'afterSha256': sha(after_path),
              'beforeSourceHashes': before['sourceHashes'], 'afterSourceHashes': after['sourceHashes'],
              'sourcesUnchangedDuringBothReplays': before['sourceUnchangedDuringReplay'] and after['sourceUnchangedDuringReplay'],
              'afterCtcMatchesFinalGate': after['sourceHashes']['ctc'] == read(OUT / 'result.json')['finalCtcSha256'],
              'sourceMetadata': str(folder / 'sadvit-original-metadata.json'),
              'referenceLimitations': after['referenceLimitations'], 'cases': rows}
    save(folder / 'sadvit-paired-comparison-final.json', result)
    return result


def notes_final():
    folder = ART / 'real-audio'
    rows = []
    for name in ('notes-uncertain-related-final.json', 'notes-clean-paired-final.json'):
        path = folder / name
        data = read(path)
        focus = []
        for left, right in zip(data['focusBefore'], data['focusAfter'], strict=True):
            focus.append({'index': left['index'], 'text': left['text'],
                          'beforeWord': [left['start'], left['end']], 'afterWord': [right['start'], right['end']],
                          'beforeLetters': left['letters'], 'afterLetters': right['letters'],
                          'beforeNotes': [{k: note[k] for k in ('midiNote', 'start', 'end')} for note in left['notes']],
                          'afterNotes': [{k: note[k] for k in ('midiNote', 'start', 'end')} for note in right['notes']],
                          'noteCoverageBeforeMs': round(1000 * left['noteSpanSeconds'], 6),
                          'noteCoverageAfterMs': round(1000 * right['noteSpanSeconds'], 6),
                          'contourPointsBefore': left['contourPointCount'], 'contourPointsAfter': right['contourPointCount']})
        rows.append({'file': str(path), 'sha256': sha(path), 'label': data['label'],
                     'comparisonStatus': data['comparisonStatus'], 'inputs': data['inputs'],
                     'checks': data['checks'], 'summary': data['summary'], 'focus': focus,
                     'removedContourPointCount': len(data['removedContourPoints']),
                     'addedContourPointCount': len(data['addedContourPoints'])})
    same_note_builder = {}
    for name in ('backend/processing/algorithms.py', 'backend/lyrics/domain.py', 'backend/lyrics/codec.py'):
        same_note_builder[name] = {'baselineSha256': sha(BASELINE / name), 'currentSha256': sha(CURRENT / name),
                                   'identical': (BASELINE / name).read_bytes() == (CURRENT / name).read_bytes()}
    result = {'scope': 'Same single real CREPE extraction, unchanged production note builder, final production word payloads.',
              'pitchIsHumanGroundTruth': False, 'newPitchInferencePerformed': False,
              'noteBuilderSources': same_note_builder, 'comparisons': rows,
              'interpretation': [
                  'Stored absolute pitch measurements never move or change frequency/confidence. Word boundaries change their text ownership and note intersections.',
                  'The related uncertain case is not exact-source-certified for its cached CTC emissions. Clean_entry is an exact paired waveform/scores control.',
                  'The 8.83–9.11 global MIDI-62 note splits at 9.00 into adjacent ya/odin intersections, without the old 10 ms seam gap.',
                  'Related-case word-note count 47→48 comes from restoring the already-existing global MIDI-60 segment 1.99–2.00 to Doma at a former 10 ms gap. The global melody is unchanged; this is not newly inferred pitch.',
                  'Additional 10 ms target frames fill formerly unsupported word-limit gaps; no previously pitched or active target frame is removed or repitched.',
                  'Quiet-tail sample retention is a preservation check, not human F0 correctness or exact word-boundary truth.',
              ]}
    save(folder / 'notes-final-summary.json', result)
    return result


if __name__ == '__main__':
    outcomes = new_outcomes()
    failures = classify_final(outcomes)
    sadvit = sadvit_final()
    notes = notes_final()
    print(json.dumps({'remainingFailures': failures['totalFailures'], 'failureCategories': failures['counts'],
                      'unchangedRelevantFiles': outcomes['allListedSourcesIdenticalBetweenV1AndFinal'],
                      'sadvitCasesUnchanged': [row['finalWordLettersIdentical'] for row in sadvit['cases']],
                      'noteComparisons': [{k: row[k] for k in ('file', 'summary')} for row in notes['comparisons']]}, ensure_ascii=False, indent=2))
