"""Export existing production documents from cached real fragments and saved pitch.

No model inference; exports are verification fixtures, not repaired user projects.
"""
from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import sys

repo = Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct')
out = Path('/tmp/karaoke-sync-v3/real-audio')
v2 = Path('/tmp/karaoke-sync-v2')
sys.path.insert(0, str(repo / 'python'))

from backend.ai.domain import PitchPoint, WordTiming
from backend.lyrics.codec import decode_document, encode_document
from backend.processing import algorithms as alg


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def sha(path):
    return sha256(path.read_bytes()).hexdigest()


pitch_path = v2 / 'real-audio/clean_entry-pitch-points.json'
pitch_data = json.loads(pitch_path.read_text())
raw_pitch = tuple(PitchPoint(p['time'], p['frequency'], p['confidence'], p.get('audioActive')) for p in pitch_data['points'])
stable_pitch = alg.stabilize_pitch(raw_pitch)
pitch_before_hash = sha(pitch_path)
source_files = {
    name: repo / 'python' / path
    for name, path in {
        'algorithms': 'backend/processing/algorithms.py',
        'lyricsDomain': 'backend/lyrics/domain.py',
        'lyricsCodec': 'backend/lyrics/codec.py',
        'ctc': 'backend/ai_worker/ctc.py',
        'speech': 'backend/ai_worker/speech.py',
        'wordGuidance': 'backend/ai_worker/word_guidance.py',
    }.items()
}
source_hashes_before = {name: sha(path) for name, path in source_files.items()}
results = []
for key, before_path, after_path, provenance in [
    ('clean-entry', v2 / 'odin/production-clean-paired.json', out / 'final-clean-paired.json', 'Paired clean_entry waveform and CTC. Cached ASR and CREPE are model observations, not human labels.'),
    ('uncertain-related', v2 / 'odin/production-uncertain-related.json', out / 'final-uncertain-related.json', 'Uncertain CTC paired with related clean_entry waveform. Exact-source pairing is not established; not an acoustic certification of9.10s.'),
]:
    before = json.loads(before_path.read_text())
    after = json.loads(after_path.read_text())
    docs = []
    for replay in (before, after):
        words = replay['payload']['words']
        timings = tuple(WordTiming(w['text'], w['start'], w['end'], w['confidence'], tuple(w['letters']), tuple(w['diagnostics'])) for w in words)
        doc = alg.construct_document('Wildways excerpt', 'fixture', replay['inputs']['duration'], ' '.join(w.text for w in timings), timings, stable_pitch, alg.MusicMetadata(None, None))
        doc.validate()
        docs.append(doc)
    before_encoded, after_encoded = [encode_document(d) for d in docs]
    directory = out / 'generated-documents' / key
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / 'lyricsSync.json'
    target.write_text(after_encoded)
    checks = {
        'sameReplayInputs': before['inputs'] == after['inputs'],
        'sameBackendSourceHashes': before['sourceHashes'] == after['sourceHashes'],
        'replayPayloadStableJsonBytesEqual': canonical(before['payload']) == canonical(after['payload']),
        'documentEquality': docs[0] == docs[1],
        'encodedDocumentBytesEqual': before_encoded.encode() == after_encoded.encode(),
        'codecRoundTrip': decode_document(target.read_text()) == docs[1],
        'wordLetterNoteObjectsUnchanged': docs[0].words == docs[1].words,
        'targetFrames10msExactlyEqual': list(docs[0].target_frames(.01)) == list(docs[1].target_frames(.01)),
        'targetFrames5msExactlyEqual': list(docs[0].target_frames(.005)) == list(docs[1].target_frames(.005)),
        'lyricsTextLinesUnchanged': docs[0].lyrics == docs[1].lyrics,
    }
    metadata = {
        'kind': 'verification_export',
        'userProject': False,
        'provenance': provenance,
        'scope': 'Production construct_document/encode_document using fresh cached-input word replay and the existing1701 CREPE observations. No full-song processing, independent listening, or new pitch inference.',
        'beforeReplay': {'path': str(before_path), 'sha256': sha(before_path)},
        'finalReplay': {'path': str(after_path), 'sha256': sha(after_path)},
        'pitch': {'path': str(pitch_path), 'sha256': pitch_before_hash, 'points': len(raw_pitch)},
        'export': {'path': str(target), 'sha256': sha(target), 'durationSeconds': docs[1].duration, 'words': len(docs[1].words), 'notes': sum(len(w.notes) for w in docs[1].words), 'targetFrames10ms': len(list(docs[1].target_frames(.01)))},
        'checks': checks,
        'words': [
            {'index': i, 'text': w.text, 'start': w.start, 'end': w.end, 'letters': list(w.letters), 'notes': [{'pitch': n.note, 'start': n.start, 'end': n.end} for n in w.notes]}
            for i, w in enumerate(docs[1].words)
        ],
    }
    (directory / 'PROVENANCE.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
    results.append(metadata)
    if not all(checks.values()):
        raise AssertionError(f'{key}: {checks}')
result = {
    'createdUtc': datetime.now(timezone.utc).isoformat(),
    'sourceHashesBefore': source_hashes_before,
    'sourceHashesAfter': {name: sha(path) for name, path in source_files.items()},
    'pitchFileUnchanged': pitch_before_hash == sha(pitch_path),
    'exports': results,
}
result['sourcesUnchanged'] = result['sourceHashesBefore'] == result['sourceHashesAfter']
(out / 'lyric-document-export-proof.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps({'sourcesUnchanged': result['sourcesUnchanged'], 'pitchUnchanged': result['pitchFileUnchanged'], 'exports': [{'export': r['export'], 'checks': r['checks']} for r in results]}, ensure_ascii=False, indent=2))
