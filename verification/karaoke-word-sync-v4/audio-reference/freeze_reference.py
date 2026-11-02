"""Freeze external annotation references before inspecting karaoke model outputs."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import re
from datetime import datetime, timezone
import wave

ROOT = Path(__file__).parent
DATA = ROOT / 'gtsinger' / 'Аня Облонская'
refs = []
for group in ('Control_Group', 'Breathy_Group'):
    for number in ('0000', '0001'):
        stem = DATA / group / number
        label = stem.with_suffix('.json')
        grid = stem.with_suffix('.TextGrid')
        wav = stem.with_suffix('.wav')
        data = json.loads(label.read_text())
        tier = grid.read_text().split('name = "word"', 1)[1].split('item [2]', 1)[0]
        grid_words = re.findall(r'intervals \[\d+\]:\s*xmin = ([\d.]+)\s*xmax = ([\d.]+)\s*text = "([^"]*)"', tier)
        assert [(float(s), float(e), w) for s, e, w in grid_words] == [(w['start_time'],w['end_time'],w['word']) for w in data]
        with wave.open(str(wav), 'rb') as audio:
            rate, frames, channels, width = audio.getframerate(), audio.getnframes(), audio.getnchannels(), audio.getsampwidth()
        words = []
        for row in data:
            if row['word'].startswith('<'):
                continue
            ds = [e-s for s,e in zip(row['ph_start'],row['ph_end'])]
            uniform = len(ds) >= 3 and max(ds)-min(ds) <= .00101
            flags = []
            if uniform:
                flags.append('UniformPhoneSubdivisionNeedsAudit')
            if row['word'] == 'гордые':
                flags.append('LongApproximantPhoneNeedsAudit')
            words.append({
                'index': len(words), 'text': row['word'], 'start': row['start_time'], 'end': row['end_time'],
                'phones': [{'text': p, 'start':s, 'end':e} for p,s,e in zip(row['ph'],row['ph_start'],row['ph_end'])],
                'note':row['note'], 'noteStart':row['note_start'], 'noteEnd':row['note_end'],
                'referenceWordKind':'published_manual_correction', 'referencePhoneKind':'published_manual_correction',
                'phoneMetricEligible': not flags, 'phoneQualityFlags':flags,
                'referenceAccuracyMs': None,
            })
        refs.append({
            'case': group.lower().removesuffix('_group') + '_' + number,
            'language':'ru', 'song':'Аня Облонская', 'singer':'RU-Alto-1', 'group':group,
            'audioPath':str(wav), 'annotationPath':str(label), 'textGridPath':str(grid),
            'sampleRate':rate, 'frames':frames, 'channels':channels, 'sampleWidthBytes':width,
            'duration':frames/rate, 'lyrics':' '.join(w['text'] for w in words),
            'audioSha256':hashlib.sha256(wav.read_bytes()).hexdigest(),
            'annotationSha256':hashlib.sha256(label.read_bytes()).hexdigest(),
            'textGridSha256':hashlib.sha256(grid.read_bytes()).hexdigest(),
            'words': words,
        })
output={
    'frozenAtUtc':datetime.now(timezone.utc).isoformat(),
    'selection':'First two indexed clips of Control_Group and Breathy_Group of the first Russian breathy-song entry. Chosen before seeing any v3/v4 outputs; no outcome-based replacement.',
    'source':'https://huggingface.co/datasets/GTSinger/GTSinger',
    'referenceMethod':'Authors used MFA for initial alignment then manually corrected word and phoneme boundaries using listening and spectrograms. These external reference labels are independent of this project and its CTC/ASR models. They are not our own listening annotations and contain detectable quality issues. No guaranteed per-boundary accuracy is published.',
    'paper':'https://arxiv.org/html/2409.13832v3#S3.SS3',
    'license':'CC BY-NC-SA 4.0; see saved full dataset license including additional terms. Do not bundle audio into application release.',
    'metadataTextGridEquality':True,
    'wordMetrics':'Compare start/end to external labels for all selected words; signed ms = predicted-reference. Keep every result including regressions.',
    'phoneMetrics':'Exclude flagged uniform or suspect approximant labels; grapheme/phoneme many-to-many mappings need explicit treatment, not index-wise comparison.',
    'countWords':sum(len(r['words']) for r in refs),
    'cases': refs,
}
path = ROOT/'frozen-reference.json'
path.write_text(json.dumps(output,ensure_ascii=False,indent=2))
(ROOT/'frozen-reference.sha256').write_text(hashlib.sha256(path.read_bytes()).hexdigest()+'  frozen-reference.json\n')
print('cases',len(refs),'words',output['countWords'],'duration',sum(r['duration'] for r in refs))
print('referenceSha256',hashlib.sha256(path.read_bytes()).hexdigest())
for r in refs:print(r['case'],r['duration'],r['lyrics'])
