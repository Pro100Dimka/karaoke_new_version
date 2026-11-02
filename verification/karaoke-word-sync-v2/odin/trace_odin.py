"""Trace the supplied regression without loading ASR/MMS models or changing product code."""
from __future__ import annotations
from contextlib import ExitStack
from dataclasses import asdict, is_dataclass
from functools import wraps
from hashlib import sha256
import argparse, json, sys
from pathlib import Path
from unittest.mock import patch

p=argparse.ArgumentParser()
p.add_argument('--repo',type=Path,required=True)
p.add_argument('--out',type=Path,required=True)
p.add_argument('--case',choices=['uncertain','overlap'],default='uncertain')
p.add_argument('--label',default='diagnostic')
a=p.parse_args();sys.path.insert(0,str(a.repo/'python'))
import numpy as np
import torch
from backend.ai_worker import ctc, speech, word_guidance as wg, recognition
source_modules = [('ctc', ctc), ('speech', speech), ('word_guidance', wg), ('recognition', recognition)]
source_hashes_before = {name: sha256(Path(module.__file__).read_bytes()).hexdigest() for name, module in source_modules}

def serialize(value):
    if is_dataclass(value):return asdict(value)
    if isinstance(value,torch.Tensor):return {'tensorShape':list(value.shape),'dtype':str(value.dtype)}
    if isinstance(value,np.ndarray):return {'arrayShape':list(value.shape),'dtype':str(value.dtype),'active':int(value.sum()) if value.dtype==bool else None}
    if isinstance(value,dict):return {str(k):serialize(v) for k,v in value.items()}
    if isinstance(value,(list,tuple,set,frozenset)):return [serialize(v) for v in value]
    if callable(value):return repr(value)
    if isinstance(value,Path):return str(value)
    if isinstance(value,np.generic):return value.item()
    return value

with np.load(a.repo/'python/tests/fixtures/wildways-verse-entry.npz') as f:
    case=json.loads(str(f[a.case+'_metadata']))
    scores=torch.from_numpy(f[a.case+'_scores'])
records=[];stack=[]
def trace(label,fn):
    @wraps(fn)
    def wrapped(*args,**kwargs):
        index=len(records)
        row={'id':index,'stage':label,'parent':stack[-1] if stack else None,'args':serialize(args),'kwargs':serialize(kwargs)}
        records.append(row);stack.append(index)
        try:
            result=fn(*args,**kwargs)
            row['result']=serialize(result)
            return result
        except Exception as exc:
            row['exception']=f'{type(exc).__name__}: {exc}'
            raise
        finally:stack.pop()
    return wrapped

def no_model(*args,**kwargs):
    raise AssertionError('diagnostic forbids new ASR/MMS inference')
def no_recognition(*args,**kwargs):
    raise FileNotFoundError('no additional cached decoder output')

with ExitStack() as patches:
    patches.enter_context(patch.object(speech,'read_mono',lambda *_:np.zeros(16*16000,np.float32)))
    patches.enter_context(patch.object(speech,'_alignment_evidence',lambda *_args,**_kwargs:(scores,0.02,case['heard'])))
    patches.enter_context(patch.object(speech,'vocal_onsets',lambda *_:np.array(case['onsets'])))
    patches.enter_context(patch.object(speech,'voiced_frames',lambda *_:np.ones(1600,bool)))
    patches.enter_context(patch.object(speech,'with_voice_onsets',lambda words,*_:words))
    patches.enter_context(patch.object(speech,'with_sung_ends',lambda words,*_:words))
    patches.enter_context(patch.object(speech,'_accelerated_guidance',no_recognition))
    patches.enter_context(patch.object(speech,'_speech_model',no_model))
    patches.enter_context(patch.object(ctc,'_model',no_model))
    for module,names in [
        (speech,['align_words','_alignment_windows','contextual_guidance','_heard_timings','guidance_positions','align_guided','with_word_guidance','with_voice_onsets','with_sung_ends','ordered','independent_timings','rate_review_indices','with_sung_letters','alignment_payload']),
        (ctc,['align_words','_align_window','_preferred','ordered']),
        (wg,['recognized_phrase','_best_phrase_match','_character_intervals','_recognized_cores','_unrecognized_runs','_candidates','_core_candidates','_onset_confidence','_crosses_confirmed_entry','_select_sequence','_review_windows','_supported_review']),
    ]:
        for name in names:
            patches.enter_context(patch.object(module,name,trace(module.__name__.rsplit('.',1)[-1]+'.'+name,getattr(module,name))))
    result=speech.align(Path('voice.wav'),case['lyrics'],'Russian',case['hints'])
report={'case':a.case,'sourceHash':{name:sha256(Path(module.__file__).read_bytes()).hexdigest() for name,module in [('ctc',ctc),('speech',speech),('word_guidance',wg),('recognition',recognition)]},'metadata':case,'payload':result,'records':records}
report['executionLabel'] = a.label
report['sourceHashesBefore'] = source_hashes_before
report['sourcesUnchangedDuringRun'] = source_hashes_before == report['sourceHash']
a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(json.dumps(report,ensure_ascii=False,indent=2))
print('saved',a.out,'records',len(records))
for row in records:
    if row['stage'] in {'speech.align_words','speech.align_guided','speech.with_word_guidance','speech.with_voice_onsets','speech.with_sung_ends','speech.ordered','speech.with_sung_letters'}:
        print(row['stage'],[(i,x['text'],x['start'],x['end'],x['score']) for i,x in enumerate(row.get('result',[])) if 7<=i<=11])
print('payload',[x for x in result['words'] if x['text']=='один'])
