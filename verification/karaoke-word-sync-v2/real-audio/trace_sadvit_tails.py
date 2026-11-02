"""Read-only stage traces for SadSvit tail evidence; no threshold/algorithm changes."""
from pathlib import Path
from unittest.mock import patch
import json,sys,hashlib
import numpy as np
import torch
from scipy.ndimage import median_filter
from scipy.spatial.distance import cdist
ROOT=Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python')
OUT=Path('/tmp/karaoke-sync-v2/real-audio')
sys.path.insert(0,str(ROOT))
from backend.ai_worker import ctc,timing
from dataclasses import asdict
torch.set_num_threads(1);torch.set_num_interop_threads(1)
fixtures=ROOT/'tests'/'fixtures';cases=[];metadata_all={}
with np.load(fixtures/'sadvit-phrase-ends.npz') as f:
 metadata_all['sadvit-phrase-ends']=json.loads(str(f['metadata']))
 for case in metadata_all['sadvit-phrase-ends']['cases']:
  s=case['word'];off=case['offset'];key=case['key']
  w=ctc.AlignedWord(s['text'],s['start']-off,s['end']-off,tuple(t-off for t in s['letters']),s['score'])
  cases.append((key,off,w,f['vocal'+key].astype(np.float32),f['instrumental'+key].astype(np.float32),case['referenceEnd']))
with np.load(fixtures/'sadvit-outro.npz') as f:
 metadata_all['sadvit-outro']=json.loads(str(f['metadata']));off=181
 w=ctc.align_words(torch.from_numpy(f['scores']),.02,['навіки'])[0]
 cases.append(('outro',off,w,f['vocal'].astype(np.float32),f['instrumental'].astype(np.float32),[182.3,182.6]))
(OUT/'sadvit-original-metadata.json').write_text(json.dumps(metadata_all,ensure_ascii=False,indent=2))
reports=[]
for name,offset,word,vocal,backing,ref in cases:
 captured={}
 orig_vad=timing.get_vad_model
 orig_source=timing._source_evidence
 orig_singing=ctc.singing_frames
 orig_harm=ctc.harmonic_evidence
 orig_cont=ctc.continued_frames
 def vad_factory():
  model=orig_vad()
  def call(samples):
   result=model(samples);captured['vad']=result.reshape(-1).copy();return result
  return call
 def source(*a):
  result=orig_source(*a);captured['source']=result;return result
 def singing(*a):
  result=orig_singing(*a);captured['singing']=result;return result
 def harm(*a):
  result=orig_harm(*a);captured['harmonics']=result;return result
 def continued(*a):
  result=orig_cont(*a);captured['continued']=result;captured['continuedBounds']=a[2];return result
 with patch.object(timing,'get_vad_model',vad_factory),patch.object(timing,'_source_evidence',source),patch.object(ctc,'singing_frames',singing),patch.object(ctc,'harmonic_evidence',harm),patch.object(ctc,'continued_frames',continued):
  final=ctc.with_sung_ends([word],vocal,backing)[0]
 audible=timing.voiced_frames(vocal,16000,160);levels,threshold=timing._levels(vocal,160)
 speech=np.interp(np.arange(len(audible))*.01,np.arange(len(captured['vad']))*512/16000,captured['vad'])
 dominance,coherence=captured['source'];smooth=median_filter(dominance,size=31)
 envelope,periodicity=captured['harmonics'];first=int(word.start/.01);last=max(first+1,min(len(audible),int(word.end/.01)))
 reference=envelope[first:last][periodicity[first:last]>=.5];radius=float(np.percentile(cdist(reference,reference),95)) if len(reference)>=2 else None
 distance=np.full(len(audible),np.nan)
 if radius is not None: distance[first:]=cdist(envelope[first:len(audible)],reference).min(axis=1)
 rows=[]
 for i in range(max(0,first-30),min(len(audible),round((ref[1]-offset+1.0)/.01))):
  rows.append({'t':round(offset+i*.01,3),'levelDbfs':float(levels[i]),'audible':bool(audible[i]),'speechProbability':float(speech[i]),'dominance':float(dominance[i]),'smoothDominance':float(smooth[i]),'coherence':float(coherence[i]),'singing':bool(captured['singing'][i]),'periodicity':float(periodicity[i]),'harmonicDistance':None if np.isnan(distance[i]) else float(distance[i]),'harmonicMatch':None if radius is None or np.isnan(distance[i]) else bool(distance[i]<=radius or periodicity[i]<.5),'continued':bool(captured['continued'][i])})
 fn=OUT/f'sadvit-tail-{name}.npz';np.savez_compressed(fn,vocal=vocal,instrumental=backing)
 reports.append({'case':name,'offset':offset,'rawCore':asdict(word),'final':asdict(final),'referenceEnd':ref,'audibilityThresholdDbfs':threshold,'harmonicReferenceFrameCount':len(reference),'harmonicRadius95Percentile':radius,'rows':rows,'sourceArrayFile':str(fn),'firstContinuedFalseAtOrAfterRawEnd':next((round(offset+i*.01,3) for i in range(int(word.end/.01),len(captured['continued'])) if not captured['continued'][i]),None),'limitations':'Activity/model/harmonic matches describe why existing code extends. They do not identify a true lyric release or distinguish reverb from a quiet vowel by themselves.'})
result={'sourceCodeHashes':{n:hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest() for n,m in [('ctc',ctc),('timing',timing)]},'metadataFile':str(OUT/'sadvit-original-metadata.json'),'cases':reports}
(OUT/'sadvit-tail-trace.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
for r in reports:
 print(r['case'],'final',r['final']['end']+r['offset'],'radius',r['harmonicRadius95Percentile'],'firstFalse',r['firstContinuedFalseAtOrAfterRawEnd'])
 for row in r['rows']:
  if round(row['t']*100)%10==0 and r['referenceEnd'][0]-.05<=row['t']<=r['final']['end']+r['offset']+.15:print(json.dumps(row))
