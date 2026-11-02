"""Replay paired clean_entry waveform/emissions with its recorded local ASR output.
No generated model results. Whole CTC, windows, onset/tail/letters, VAD and review run normally.
"""
from __future__ import annotations
import argparse,json,sys
from dataclasses import asdict,is_dataclass
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
from hashlib import sha256
p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--local-asr',action='store_true');p.add_argument('--uncertain-related',action='store_true');p.add_argument('--label',default='diagnostic');a=p.parse_args();sys.path.insert(0,str(a.repo/'python'))
import numpy as np,torch
from backend.ai_worker import speech,ctc,timing,word_guidance,recognition
source_modules = [('ctc', ctc), ('speech', speech), ('timing', timing), ('word_guidance', word_guidance), ('recognition', recognition)]
source_hashes_before = {name: sha256(Path(module.__file__).read_bytes()).hexdigest() for name, module in source_modules}
with np.load(a.repo/'python/tests/fixtures/wildways-verse-entry.npz') as f:
    case=json.loads(str(f['clean_entry_metadata']));vocal=f['clean_entry_vocal'].astype(np.float32);backing=f['clean_entry_instrumental'].astype(np.float32);scores=torch.from_numpy(f['clean_entry_scores']);uncertain=json.loads(str(f['uncertain_metadata']));lyrics=uncertain['lyrics']
    if a.uncertain_related:
        scores=torch.from_numpy(f['uncertain_scores']);vocal=vocal[:16*16000];backing=backing[:16*16000]
texts=[x['text'] for x in case['whole']]
hints=[{'start':w['heard_start'],'text':' '.join(texts[w['first']:w['last']])} for w in case['windows']]
if a.uncertain_related:
    hints=uncertain['hints'];case['heard']=uncertain['heard']
def payload(view):return {'segments':[{'words':[dict(word=k,start=s,end=e) for k,s,e in view]}]}
requests=[];events=[]
def no_model(*args,**kwargs):raise AssertionError('No new ASR/MMS model in cached replay')
def local(_vocal,_language,_prompt,contexts,**kwargs):
    requests.extend([list(x) for x in contexts])
    if not a.local_asr:raise FileNotFoundError('local cached output deliberately unavailable')
    return {'contexts':[payload([w for w in case['recognized'] if w[2]>start and w[1]<end]) for start,end,_ in contexts]}
def observe(label,fn):
    def wrapped(*args,**kwargs):
        result=fn(*args,**kwargs)
        entry={'stage':label}
        if label=='contextual_guidance':
            entry['windows']=[asdict(w) for w in result[0]];entry['supported']=result[1]
        elif label=='_alignment_windows':entry['windows']=[asdict(w) for w in result]
        elif label=='rate_review_indices':entry['reviewed']=sorted(result)
        else:
            entry['words']=[asdict(w) for w in result]
            if 'reviewed'in kwargs:entry['reviewed']=sorted(kwargs['reviewed'])
        events.append(entry);return result
    return wrapped
with ExitStack() as patches:
    patches.enter_context(patch.object(speech,'read_mono',lambda path,*_:backing if path.name=='backing.wav' else vocal))
    patches.enter_context(patch.object(speech,'emission',lambda samples:(scores,.02)))
    patches.enter_context(patch.object(speech,'_guidance',lambda *args,**kwargs:payload(case['heard'])))
    patches.enter_context(patch.object(speech,'_accelerated_guidance',local))
    patches.enter_context(patch.object(speech,'_speech_model',no_model))
    patches.enter_context(patch.object(ctc,'_model',no_model))
    for name in ('align_words','_alignment_windows','contextual_guidance','align_guided','with_word_guidance','with_voice_onsets','with_sung_ends','with_sung_letters','ordered','rate_review_indices'):
        patches.enter_context(patch.object(speech,name,observe(name,getattr(speech,name))))
    result=speech.align(Path('vocal.wav'),lyrics,'Russian',hints,Path('backing.wav'))
report={'case':'uncertain emissions/ASR with related clean_entry wave; not exact-source certified' if a.uncertain_related else 'paired clean_entry','localAsrAvailable':a.local_asr,'sourceHashes':{name:sha256(Path(module.__file__).read_bytes()).hexdigest() for name,module in [('ctc',ctc),('speech',speech),('timing',timing),('word_guidance',word_guidance),('recognition',recognition)]},'inputs':{'vocalSha256':sha256(vocal.tobytes()).hexdigest(),'instrumentalSha256':sha256(backing.tobytes()).hexdigest(),'scoresSha256':sha256(scores.numpy().tobytes()).hexdigest(),'duration':len(vocal)/16000,'hintsDerivedFrom':'uncertain_metadata.hints' if a.uncertain_related else 'existing clean_entry_metadata.windows heard_start and text ranges','hints':hints,'localAsrProvenance':'existing clean_entry_metadata.recognized; treated as local contextual output, not asserted independent unprompted ASR'},'contextRequests':requests,'stages':events,'payload':result}
report['executionLabel'] = a.label
report['sourceHashesBefore'] = source_hashes_before
report['sourcesUnchangedDuringRun'] = source_hashes_before == report['sourceHashes']
a.out.write_text(json.dumps(report,ensure_ascii=False,indent=2))
print('saved',a.out)
for event in events:
    if 'words' in event:print(event['stage'],[(w['text'],w['start'],w['end'],w['letters'],w['score']) for w in event['words'][7:12]])
    elif 'reviewed' in event:print(event['stage'],event['reviewed'])
print('final',result['words'][8:11])
