"""Compare all samples from both execution orders, preserving timing dispersion and payload deltas."""
import json
from pathlib import Path
import statistics

root = Path(__file__).resolve().parent
runs = {name: [json.loads((root / f'{name}{suffix}.json').read_text())
               for suffix in ('', '-reverse')]
        for name in ('original', 'v1', 'final')}
result = {
    'scope': 'CPU local forced alignment and postprocessing; cached CTC/ASR/singing masks, no model inference or audio decoding',
    'method': 'One CPU thread, two process execution orders original/v1/final and final/v1/original; three warmups plus nine timed runs per process and case; all 18 observations retained',
    'limits': ['Shared execution host: wall-time dispersion is reported, not removed.',
               'Not a full-song separation/ASR/MMS/CREPE pipeline benchmark.',
               'Window prototype microbenchmarks are separate and are not final production timings.'],
    'cases': [],
}
for index, name in enumerate(('fast', 'native_fast', 'reply')):
    row = {'case': name, 'durationSeconds': runs['final'][0]['cases'][index]['fragmentDurationSeconds'],
           'versions': {}, 'payloadChangesV1ToFinal': []}
    for version, batches in runs.items():
        cases = [batch['cases'][index] for batch in batches]
        samples = [value for case in cases for value in case['runtime']['runsMs']]
        assert cases[0]['finalPayload'] == cases[1]['finalPayload']
        assert all(all(case['assertions'].values()) for case in cases)
        row['versions'][version] = {
            'medianMs': statistics.median(samples), 'minMs': min(samples), 'maxMs': max(samples),
            'batchMediansMs': [case['runtime']['medianMs'] for case in cases],
            'allRunsMs': samples, 'calls': cases[0]['calls'], 'inputs': cases[0]['inputs'],
        }
    assert row['versions']['v1']['inputs'] == row['versions']['final']['inputs']
    before = runs['v1'][0]['cases'][index]['finalPayload']['words']
    after = runs['final'][0]['cases'][index]['finalPayload']['words']
    for position, (a, b) in enumerate(zip(before, after, strict=True)):
        if a != b:
            row['payloadChangesV1ToFinal'].append({'index': position, 'before': a, 'after': b})
    row['checks'] = {
        'sameStarts': [word['start'] for word in before] == [word['start'] for word in after],
        'sameLetters': [word['letters'] for word in before] == [word['letters'] for word in after],
        'endDeltaMinMs': min((b['end'] - a['end']) * 1000 for a, b in zip(before, after, strict=True)),
        'endDeltaMaxMs': max((b['end'] - a['end']) * 1000 for a, b in zip(before, after, strict=True)),
        'allFixtureAssertionsPass': True,
    }
    row['medianReductionFromV1Percent'] = 100 * (1 - row['versions']['final']['medianMs'] / row['versions']['v1']['medianMs'])
    result['cases'].append(row)
(root / 'comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps([{'case': row['case'], 'medianMs': {v: round(x['medianMs'], 3) for v, x in row['versions'].items()},
                  'reductionPercent': round(row['medianReductionFromV1Percent'], 2), 'checks': row['checks'],
                  'changedWords': len(row['payloadChangesV1ToFinal']),
                  'calls': {v: x['calls'] for v, x in row['versions'].items()}}
                 for row in result['cases']], ensure_ascii=False, indent=2))
