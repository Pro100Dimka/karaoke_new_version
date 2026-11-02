"""Export numerical verification without commercial audio or complete song lyrics."""
from pathlib import Path
from hashlib import sha256
import json
import shutil
import numpy as np

WORK = Path('/tmp/karaoke-v5-artists')
DEST = Path('/workspace/scratch/513dbcd967bf/deliverables-v5-artists/evidence')
DEST.mkdir(parents=True, exist_ok=True)
ALLOWED = {
    'antytila_lovy_moment': {'у', 'ці', 'пригоди'},
    'otorvald_bez_tebe': {'без'},
    'pivovarov_dezhavyu_ua': {'хвилями', 'як', 'дежавю'},
}

def digest(path):
    return sha256(path.read_bytes()).hexdigest()

def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')

def token(text, case):
    key = text.lower().strip('.,!?;:')
    result = {'textSha256':sha256(text.encode()).hexdigest(), 'characterCount':len(text)}
    if key in ALLOWED.get(case, {'смотрят','как','о','походе','плывут'}):
        result['excerpt'] = text
    return result

def safe(value, case=''):
    if isinstance(value, list):
        return [safe(v, case) for v in value]
    if not isinstance(value, dict):
        return value
    case = value.get('case', case)
    result = {}
    for key, item in value.items():
        if key in {'lyrics','fullPublishedLyrics','recognizedText','transcript'}:
            result[key+'Sha256'] = sha256(str(item).encode()).hexdigest()
        elif key in {'text','word'} and isinstance(item,str):
            result.update(token(item,case))
        elif key == 'characters':
            # Full phone text is unnecessary to verify indexed numerical boundaries.
            result['characterLabelSha256'] = sha256(str(item).encode()).hexdigest()
        elif key == 'words' and isinstance(item,list) and all(isinstance(v,str) for v in item):
            result['wordCount'] = len(item)
        else:
            result[key] = safe(item,case)
    return result

def trace_metadata(folder, case, version):
    source=folder/'metadata.json'
    metadata=json.loads(source.read_text())
    assert metadata['completed'] and metadata['sourceHashesUnchanged'] and metadata['audioHashUnchanged']
    for key in ('instrumentalHashUnchanged','recognitionHashUnchanged'):
        if key in metadata:assert metadata[key]
    keys=('completed','mode','elapsedSeconds','sourceHashesUnchanged','audioHashUnchanged',
          'sourceHashes','instrumentalHashUnchanged','recognitionHashUnchanged','inputs',
          'inputManifestSha256','referenceLabelsPassedToModels','scriptSha256')
    write(DEST/'trace-metadata'/case/(version+'.json'),{
        'sourceMetadataSha256':digest(source),
        **safe({k:metadata[k] for k in keys if k in metadata},case)})

inputs=json.loads((WORK/'alignment-inputs.json').read_text())
source_manifest={'scope':'Public source identity and selected crops. No manual word/phone labels exist for these recordings. Full commercial lyrics and audio are omitted.', 'inputManifestSha256':digest(WORK/'alignment-inputs.json'),'cases':[]}
for c in inputs['cases']:
    source_manifest['cases'].append({**{k:v for k,v in c.items() if k not in {'lyrics','audioPath','instrumentalPath','recognitionPath','mixPath','originalPath'}},
      'wordCount':len(c['lyrics'].split()),'lineWordCounts':[len(line.split()) for line in c['lyrics'].splitlines()],
      'lyricsSha256':sha256(c['lyrics'].encode()).hexdigest()})
write(DEST/'artist-sources.json',source_manifest)

for name in ('artist-comparison.json','ru-comparison.json','notes-artists/note-comparison.json',
             'notes-previous/note-comparison.json','frontend-artists.json','frontend-previous.json',
             'notes-reference-comparison.json','ten-artist-word-examples.json',
             'notes-previous-all-changes/note-comparison.json',
             'frontend-previous-all-changes.json','frontend-ru-all.json',
             'notes-reference-comparison-all-changes.json'):
    src=WORK/name
    if src.exists():
        write(DEST/name,safe(json.loads(src.read_text())))

for c in inputs['cases']:
    name=c['case']
    for version in ('baseline-v4-replay','final-v5'):
        folder=WORK/'runs'/version/name
        trace_metadata(folder,name,version)
        events=[]
        for event in json.loads((folder/'stages.json').read_text()):
            row={k:event[k] for k in ('sequence','stage','elapsedSeconds','reviewed') if k in event}
            for side in ('inputWords','outputWords'):
                if side in event:
                    row[side]=[safe(w,name) if isinstance(w,dict) else token(w,name) for w in event[side]]
            events.append(row)
        write(DEST/'traces'/name/(version+'.json'),{'sourceTraceSha256':digest(folder/'stages.json'),'case':name,'events':events})
    cache=WORK/'runs/baseline-v4-fresh'/name/'acoustic-cache.npz'
    target=DEST/'ctc-evidence'/(name+'.npz')
    target.parent.mkdir(parents=True,exist_ok=True)
    with np.load(cache) as a:
        arrays={k:a[k] for k in ('scores','frame_seconds','singing_frames','voiced_frames','vocal_onsets')}
    np.savez_compressed(target,**arrays)

old=Path('/tmp/karaoke-v4-new-songs')
reference=old/'ru-reference/frozen-reference.json'
write(DEST/'reference/frozen-reference-numerical.json',safe(json.loads(reference.read_text())))
write(DEST/'reference/frozen-phone-mapping-numerical.json',safe(json.loads((old/'ru-reference/frozen-phone-mapping.json').read_text())))
for c in json.loads(reference.read_text())['cases']:
    name=c['case']
    for version,base in [('baseline-v4-replay',old/'runs/v4-replay'),('final-v5',WORK/'runs/previous-final-v5')]:
        folder=base/name
        trace_metadata(folder,name,version)
        events=[]
        for event in json.loads((folder/'stages.json').read_text()):
            row={k:event[k] for k in ('sequence','stage','elapsedSeconds','reviewed') if k in event}
            for side in ('inputWords','outputWords'):
                if side in event:
                    row[side]=[safe(w,name) if isinstance(w,dict) else token(w,name) for w in event[side]]
            events.append(row)
        write(DEST/'traces'/name/(version+'.json'),{'sourceTraceSha256':digest(folder/'stages.json'),'case':name,'events':events})
    target=DEST/'ctc-evidence'/(name+'.npz')
    with np.load(old/'runs/v4-replay'/name/'acoustic-cache.npz') as a:
        arrays={k:a[k] for k in ('scores','frame_seconds','singing_frames','voiced_frames','vocal_onsets')}
    np.savez_compressed(target,**arrays)

files=[
 'final-source-freeze-v5.json','final-scoped-diff-inventory-v5.json',
 'backend-baseline-v4-unconfined/result.json','backend-baseline-v4-unconfined/failure-ids.txt',
 'backend-final-v5/result.json','backend-final-v5/failure-ids.txt',
 'backend-final-v5/failure-classification.json','backend-two-final-variances-idle/result.json',
 'backend-two-final-variances-plan.json',
 'backend-gate-comparison-final-v5.json','backend-six-variances-idle/result.json',
 'backend-six-variances-plan.json','frontend-final-v5/summary.json',
 'notebook-freeze-equality-v5.json','benchmark-summary.json',
 'paired-benchmark-result.json','benchmark-paired-artists.json',
 'diagnosis/bal-reference-caveat.json','diagnosis/fallback-guard-real-cache-proof.json',
 'diagnosis/guidance-acoustic-fallback-portable-red.log',
 'diagnosis/guidance-acoustic-fallback-green.log','diagnosis/portable-onset-red.log',
 'diagnosis/portable-onset-green.log','diagnosis/review-candidate-selection.log',
 'diagnosis/onset-proposal-focused.log','diagnosis/onset-proposal-focused-v2.log',
 'sources/independent-raw-stem-inspection/reference-status-and-observations.json',
 'sources/independent-raw-stem-inspection/pivovarov-first-word.json',
 'repack-base-verification.json','note-edge-interpolation-check.json',
 'diagnosis/suffix-reproducer-baseline.json','diagnosis/suffix-reproducer-final.json',
 'frontend-final-v5/failure-classification.json','final-proofs-executions.json',
 'final-input-hash-verification.json','final-product-freeze-after-verification.json',
 'final-extra-note-proofs-executions.json',
 'patch-application-proof.json','diagnosis/exported-suffix-reproducer-final.json',
]
missing=[]
for name in files:
    src=WORK/name
    if src.exists():
        out=DEST/name
        out.parent.mkdir(parents=True,exist_ok=True)
        if src.suffix=='.json':
            write(out,safe(json.loads(src.read_text())))
        else:
            shutil.copyfile(src,out)
    else:
        missing.append(name)
for folder in ('backend-baseline-v4-unconfined','backend-final-v5','frontend-final-v5','benchmark',
               'backend-two-final-variances-idle','backend-six-variances-idle'):
    src=WORK/folder
    if not src.exists():continue
    for p in sorted(src.glob('*.log')) + sorted(src.glob('*.json')) + sorted(src.glob('*.xml')):
        out=DEST/folder/p.name
        out.parent.mkdir(parents=True,exist_ok=True)
        if p.suffix=='.json':write(out,safe(json.loads(p.read_text())))
        else:shutil.copyfile(p,out)
for p in sorted((WORK/'harness').glob('*')):
    if p.is_file():
        out=DEST/'harness'/p.name
        out.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(p,out)
for name in ('diagnosis/bal-raw-reference-review.png','diagnosis/bal-paired-raw-reference-review.png'):
    src=WORK/name
    if src.exists():
        out=DEST/name
        out.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(src,out)
shutil.copyfile(DEST.parent/'recovered_word.png',DEST/'recovered_word.png')
required=['artist-comparison.json','ru-comparison.json','notes-artists/note-comparison.json',
          'notes-previous-all-changes/note-comparison.json','frontend-artists.json',
          'frontend-previous-all-changes.json','notes-reference-comparison-all-changes.json',
          'final-source-freeze-v5.json','backend-final-v5/summary.json','benchmark-summary.json',
          'backend-final-v5/failure-classification.json','final-input-hash-verification.json',
          'harness/REPRODUCTION.txt','paired-benchmark-result.json']
assert all((DEST/n).is_file() for n in required),required
write(DEST/'FILE_MANIFEST.json',{'optionalInputsAbsent':missing,'files':[{ 'path':str(p.relative_to(DEST)), 'bytes':p.stat().st_size, 'sha256':digest(p)} for p in sorted(DEST.rglob('*')) if p.is_file() and p.name!='FILE_MANIFEST.json']})
print(json.dumps({'destination':str(DEST),'files':sum(p.is_file() for p in DEST.rglob('*'))}))
