"""Screen final data and stage losses; candidates are not acoustic ground truth."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys

from compare_alignment import invariant_errors

VOWELS = set('aeiouyаеёиоуыэюяіїє')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def letter_spans(word):
    indices = [i for i, char in enumerate(word['text']) if char.isalnum() and char.casefold() not in 'ьъ']
    starts = word['letters']
    if len(starts) != len(word['text']):
        return []
    return [{'index': index, 'char': word['text'][index], 'start': starts[index],
             'end': starts[indices[j + 1]] if j + 1 < len(indices) else word['end']}
            for j, index in enumerate(indices)]


def trace_losses(events):
    rows = []
    for event in events:
        before, after = event.get('inputWords', []), event.get('outputWords', [])
        if not before or len(before) != len(after) or [w['text'] for w in before] != [w['text'] for w in after]:
            continue
        for index, (old, new) in enumerate(zip(before, after)):
            previous, current = old['end'] - old['start'], new['end'] - new['start']
            if previous - current <= .010000001:
                continue
            flags = new.get('diagnostics', [])
            rows.append({'stage': event['stage'], 'sequence': event.get('sequence'),
                'localWordIndex': index, 'text': old['text'], 'before': old, 'after': new,
                'durationLostMs': round((previous - current) * 1000, 3),
                'retainedFraction': current / previous if previous > 0 else None,
                'unmarkedOrderedLoss': event['stage'].endswith('.ordered') and not any(
                    flag in flags for flag in ('BoundaryClipped', 'BoundaryConflict')),
                'note': 'A shortening candidate; acoustic review must distinguish justified silence removal from lost pronunciation.'})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-python', type=Path, required=True)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--document-root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--case', action='append')
    parser.add_argument('--allow-partial', action='store_true')
    args = parser.parse_args()
    sys.path.insert(0, str(args.repo_python))
    from backend.ai_worker.recognition import heard_timings
    from backend.ai_worker.word_guidance import _REVIEW_MAX_SECONDS, _REVIEW_MAX_WORDS
    cases = json.loads(args.inputs.read_text())['cases']
    if args.case:
        assert set(args.case) <= {c['case'] for c in cases}
        cases = [c for c in cases if c['case'] in args.case]
    report = {'scope': 'Screening, not proof of alignment accuracy. ASR and CTC are independent model views, not human truth. Thresholds only select candidates; no boundaries are changed.',
              'inputSha256': sha(args.inputs), 'cases': [], 'pending': []}
    for case in cases:
        directory = args.run_dir / case['case']
        if not (directory / 'payload.json').exists():
            if not args.allow_partial:
                raise FileNotFoundError(directory / 'payload.json')
            report['pending'].append(case['case'])
            continue
        words = json.loads((directory / 'payload.json').read_text())['words']
        metadata = json.loads((directory / 'metadata.json').read_text())
        assert metadata['completed'] and metadata['sourceHashesUnchanged'] and metadata['audioHashUnchanged']
        assert [w['text'] for w in words] == case['lyrics'].split()
        events = json.loads((directory / 'stages.json').read_text())
        evidence = json.loads((directory / 'alignment-evidence.json').read_text())
        short, long_consonants = [], []
        for index, word in enumerate(words):
            spans = letter_spans(word)
            row = {'wordIndex': index, **word, 'durationMs': (word['end'] - word['start']) * 1000,
                   'soundingLetterIntervals': spans}
            if word['end'] - word['start'] < .08 - 1e-9:
                short.append(row)
            if spans and spans[-1]['char'].casefold() not in VOWELS:
                tail = spans[-1]['end'] - spans[-1]['start']
                duration = word['end'] - word['start']
                if tail >= .25 - 1e-9 and tail >= duration * .55 - 1e-9:
                    long_consonants.append(row)
        losses = trace_losses(events)
        matching = [heard_timings(case['lyrics'].split(), [tuple(w) for w in view])
                    for view in evidence.get('independentViews', [])]
        raw_ctc = next((e['outputWords'] for e in events
                        if e['stage'] == 'speech.align_words' and len(e.get('outputWords', [])) == len(words)), None)
        disagreements = []
        for index, final in enumerate(words):
            views = [{'viewIndex': n, 'start': match[index][0], 'end': match[index][1],
                      'finalStartDeltaMs': (final['start'] - match[index][0]) * 1000,
                      'finalEndDeltaMs': (final['end'] - match[index][1]) * 1000}
                     for n, match in enumerate(matching) if index in match]
            if any(max(abs(v['finalStartDeltaMs']), abs(v['finalEndDeltaMs'])) >= 250 for v in views):
                disagreements.append({'wordIndex': index, 'final': final,
                                      'initialCtc': raw_ctc[index] if raw_ctc else None,
                                      'asrViews': views})
        windows = []
        for event in events:
            if 'outputWindows' not in event:
                continue
            rows = event['outputWindows']
            covered = {i for w in rows for i in range(w['first'], w['last'])}
            windows.append({'sequence': event.get('sequence'), 'windows': rows,
                'missingReviewedIndices': sorted(set(event.get('reviewed', [])) - covered),
                'wordOverlap': any(a['last'] > b['first'] for a, b in zip(rows, rows[1:])),
                'audioOverlap': any(a['end'] > b['start'] + 1e-9 for a, b in zip(rows, rows[1:])),
                'oversized': [w for w in rows if w['last'] - w['first'] > _REVIEW_MAX_WORDS
                    or w['last'] - w['first'] > 1 and w['end'] - w['start'] > _REVIEW_MAX_SECONDS + 1e-9]})
        document_check = None
        if args.document_root:
            document_path = args.document_root / case['case'] / 'final' / 'lyricsSync.json'
            document = json.loads(document_path.read_text())
            saved = document['words']
            processing_path = document_path.with_name('processing-audit.json')
            processing = json.loads(processing_path.read_text())
            expected_diagnostics = [{'wordIndex': i, 'text': w['text'],
                'confidence': w['confidence'], 'diagnostics': w.get('diagnostics', [])}
                for i, w in enumerate(words)]
            document_check = {'path': str(document_path), 'sha256': sha(document_path),
                'wordLetterTimesExactlyEqualToPayload': len(saved) == len(words) and all(
                    all(a[k] == b[k] for k in ('text', 'start', 'end', 'letters')) for a, b in zip(saved, words)),
                'invariantErrors': invariant_errors(saved, case['duration']),
                'processingAuditPath': str(processing_path), 'processingAuditSha256': sha(processing_path),
                'processingAuditMatchesDocumentAndPayload': processing['documentSha256'] == sha(document_path)
                    and processing['sourcePayloadSha256'] == sha(directory / 'payload.json'),
                'processingAuditPreservesWordDiagnostics': processing['wordDiagnostics'] == expected_diagnostics,
                'processingWarnings': processing['warnings'],
                'musicCache': processing['musicCache']}
        row = {'case': case['case'], 'artist': case['artist'], 'title': case['title'],
            'durationSeconds': case['duration'], 'wordCount': len(words),
            'payloadSha256': sha(directory / 'payload.json'),
            'invariantErrors': invariant_errors(words, case['duration']),
            'diagnostics': dict(Counter(flag for w in words for flag in w.get('diagnostics', []))),
            'shorterThan80ms': short, 'longFinalConsonantCandidates': long_consonants,
            'stageDurationLossCandidates': losses,
            'unmarkedOrderedLossCount': sum(x['unmarkedOrderedLoss'] for x in losses),
            'asrBoundaryDisagreementCandidates': disagreements, 'reviewWindowPlans': windows,
            'stageCounts': dict(Counter(e['stage'] for e in events)),
            'ctcRequests': [e['ctcRequest'] for e in events if 'ctcRequest' in e],
            'tracedAlignmentSeconds': metadata['elapsedSeconds'],
            'finalSerialization': document_check}
        report['cases'].append(row)
        print(json.dumps({'case': case['case'], 'words': len(words), 'invalid': len(row['invariantErrors']),
              'short': len(short), 'longConsonants': len(long_consonants),
              'unmarkedOrderedLoss': row['unmarkedOrderedLossCount'], 'ASRDisagreements': len(disagreements)}), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
