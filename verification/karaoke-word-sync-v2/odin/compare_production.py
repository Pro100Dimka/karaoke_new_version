from pathlib import Path
from hashlib import sha256
import json

root=Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python/backend/ai_worker')
p=Path('/tmp/karaoke-sync-v2/odin')
files=[
 ('uncertain-frozen','uncertain-before-trace.json','production-uncertain-frozen.json'),
 ('uncertain-related-wave','baseline-v1-uncertain-related.json','production-uncertain-related.json'),
 ('clean-paired-control','baseline-v1-clean-paired.json','production-clean-paired.json'),
]
def core(r):
 if 'records' in r:return next(x['result'][9]for x in r['records']if x['stage']=='speech.with_word_guidance')
 return next(x['words'][9]for x in r['stages']if x['stage']=='with_word_guidance')
def distance(x):return round(max(9.42-x,0,x-9.49),9)
def word_diff(a,b):
 return [{'index':i,'before':x,'after':y}for i,(x,y)in enumerate(zip(a,b,strict=True))if x!=y]
def field_changes(a,b):
 fields=sorted(set().union(*(set(x)|set(y) for x,y in zip(a,b,strict=True))))
 return {key:[i for i,(x,y)in enumerate(zip(a,b,strict=True))if x.get(key)!=y.get(key)]for key in fields}
def end_changes(a,b):
 return [{'index':i,'text':x['text'],'before':x['end'],'after':y['end'],'deltaSeconds':round(y['end']-x['end'],9),'otherWordFieldsUnchanged':{key:value for key,value in x.items()if key!='end'}=={key:value for key,value in y.items()if key!='end'}}for i,(x,y)in enumerate(zip(a,b,strict=True))if x['end']!=y['end']]
report={'comparison':'exact delivered v1 vs final production; no prototype monkeypatch','acousticReference':{'intervalSeconds':[9.42,9.49],'basis':'independent waveform/spectrogram inspection of related fast/native_fast/clean_entry vocal arrays; medial articulation consistent with d, not a listened or human-certified phoneme label','limits':'No exact-source SHA binds uncertain scores to this wave. Initial o seam and final n/end remain uncertain. Use interval distance, not fabricated exact ground truth.'},'cases':[]}
for name,before_file,after_file in files:
 before=json.loads((p/before_file).read_text());after=json.loads((p/after_file).read_text())
 hashes=after.get('sourceHashes',after.get('sourceHash'))
 current=all(sha256((root/(key+'.py')).read_bytes()).hexdigest()==value for key,value in hashes.items())
 stable=after['sourcesUnchangedDuringRun']
 if not current or not stable:raise AssertionError((name,'stale or changing production source'))
 bw,aw=before['payload']['words'],after['payload']['words'];bc,ac=core(before),core(after)
 inputs=before.get('inputs',before.get('metadata'))==after.get('inputs',after.get('metadata'))
 row={'case':name,'beforeFile':before_file,'afterFile':after_file,'sameInputs':inputs,'sourceHashes':hashes,'productionSourcesStableAndCurrent':current and stable,'sameWholePayload':before['payload']==after['payload'],'textAndWordCountUnchanged':[x['text']for x in bw]==[x['text']for x in aw],'word9Before':bw[9],'word9After':aw[9],'rawCore9Before':bc,'rawCore9After':ac,'rawDIntervalDistanceSecondsBefore':distance(bc['letters'][1]),'rawDIntervalDistanceSecondsAfter':distance(ac['letters'][1]),'finalDIntervalDistanceSecondsBefore':distance(bw[9]['letters'][1]),'finalDIntervalDistanceSecondsAfter':distance(aw[9]['letters'][1]),'changedWords':word_diff(bw,aw)}
 assert inputs and row['textAndWordCountUnchanged']
 row['changedWordIndicesByField']=field_changes(bw,aw)
 row['endChanges']=end_changes(bw,aw)
 row['wordStartsUnchanged']=all(x['start']==y['start']for x,y in zip(bw,aw,strict=True))
 row['lettersUnchanged']=all(x['letters']==y['letters']for x,y in zip(bw,aw,strict=True))
 if name=='clean-paired-control':
  row['controlInterpretation']='Compare starts, letters, confidence and diagnostics separately from word ends. Final current-frame sung-end guard corrects supported continuous-voice seams by at most one 10-ms hop; the entire payload need not remain identical.'
 report['cases'].append(row)
paths=json.loads((p/'local-paths-before.json').read_text())
report['localCtcObjective']={'sameAudioSeconds':[7.96,11.84],'unconstrainedLogLikelihood':paths['unconstrained']['logLikelihood'],'boundedLogLikelihood':sum(x['logLikelihood']for x in paths['jointWithBothAnchors']['pieces']),'boundedLossNats':paths['jointWithBothAnchors']['logLikelihoodLossVsUnconstrained'],'interpretation':'CTC alone prefers the late path; independent neighboring timing anchors select a lower-likelihood constrained path. The improvement claim concerns acoustic-event placement and phrase ownership, not greater model confidence.'}
(p/'production-comparison.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
for x in report['cases']:
 print(x['case'],'samePayload',x['sameWholePayload'],'changes',[w['index']for w in x['changedWords']],'start',x['word9Before']['start'],'->',x['word9After']['start'],'letters',x['word9Before']['letters'],'->',x['word9After']['letters'],'final d error',x['finalDIntervalDistanceSecondsBefore'],'->',x['finalDIntervalDistanceSecondsAfter'])
