from pathlib import Path
from dataclasses import replace,asdict
import json,sys
sys.path.insert(0,'/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python')
import numpy as np,torch
from backend.ai_worker import ctc,word_guidance as wg,timing,recognition
p=Path('/tmp/karaoke-sync-v2/odin');r=json.loads((p/'uncertain-related-prototype.json').read_text())
core=[ctc.AlignedWord(**{**w,'letters':tuple(w['letters']),'diagnostics':tuple(w['diagnostics'])}) for w in next(s for s in r['stages']if s['stage']=='with_word_guidance')['words']]
with np.load('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python/tests/fixtures/wildways-verse-entry.npz') as f:
 scores=torch.from_numpy(f['uncertain_scores']);case=json.loads(str(f['uncertain_metadata']));v=f['clean_entry_vocal'][:16*16000].astype(np.float32);b=f['clean_entry_instrumental'][:16*16000].astype(np.float32)
activity=timing.singing_frames(v,b,16000,160);onsets=timing.vocal_onsets(v,16000,160).tolist()
heard=recognition.independent_timings(case['lyrics'].split(),[case['heard']],core)
core[9]=replace(core[9],diagnostics=('OnsetAtSearchBoundary','TimingReviewRequired'))
reviewed=frozenset({4,8,9})
observed=[];original=wg._supported_review

def observe(before,after,first,*args,**kwargs):
 result=original(before,after,first,*args,**kwargs)
 observed.append({'first':first,'before':[asdict(x) for x in before],'after':[asdict(x) for x in after],'accepted':result})
 return result
wg._supported_review=observe
out=wg.with_word_guidance(core,scores,.02,[],heard,activity,.6,onsets=onsets,reviewed=reviewed)
report={'reviewed':sorted(reviewed),'heard':heard,'before':asdict(core[9]),'after':asdict(out[9]),'observed':observed}
(p/'explicit-review-before.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print('explicit review9',report['before'],report['after'])
