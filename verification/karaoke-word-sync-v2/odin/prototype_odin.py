"""Outside-repository causal experiment: bounded candidate from independent next phrase.
No timing constant or word spelling specific to the failing fixture is used by the candidate rule.
This is not a delivered product patch.
"""
from __future__ import annotations
import argparse,json,sys,runpy
from pathlib import Path
from unittest.mock import patch
p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--real-wave',choices=['related','clean']);a=p.parse_args();sys.path.insert(0,str(a.repo/'python'))
import numpy as np,torch
from backend.ai_worker import ctc,word_guidance as wg
original=wg._recognized_cores
proposals=[]
def candidates(words,scores,step,window,heard,voiced,margin,onsets=(),reviewed=frozenset()):
    result=original(words,scores,step,window,heard,voiced,margin,onsets,reviewed)
    index=window.last-1
    if not 0<=index<len(words)-1 or (interval:=heard.get(index)) is None:return result
    word=words[index]
    if word.start-interval[0]<=margin or wg._onset_confidence(word,scores,step)>ctc._PREFERENCE:return result
    following=list(words[index+1:index+3])
    search=ctc.Window(index+1,index+1+len(following),max(interval[0],following[0].start-margin),min(len(scores)*step,following[-1].end+margin))
    after=ctc._align_window(scores,step,[w.text for w in following],search)
    boundary=after[0].start
    if (not interval[0]<boundary<word.end or abs(boundary-following[0].start)>ctc._HEARD_DISAGREEMENT_SECONDS or after[0].score<following[0].score or len(after)>1 and after[0].end>following[1].start):return result
    begin,end=round(max(window.start,interval[0])/step),round(boundary/step)
    candidate=ctc.align_words(scores[begin:end],step,[word.text],begin*step,bounded_end=True)[0]
    if (candidate.score<=0 or abs(interval[0]-word.start)-abs(interval[0]-candidate.start)<=ctc._HEARD_DISAGREEMENT_SECONDS or wg._onset_confidence(word,scores,step)>candidate.score+ctc._PREFERENCE or wg._crosses_confirmed_entry(word,candidate,interval,onsets) or ctc._implausible([candidate],voiced)>ctc._implausible([word],voiced)):return result
    proposals.append({'index':index,'before':str(word),'candidate':str(candidate),'followingBefore':str(following[0]),'followingCandidate':str(after[0]),'search':str(search)})
    return result+[(index,candidate,interval),(index+1,after[0],heard.get(index+1,(after[0].start,after[0].end)))]
with patch.object(wg,'_recognized_cores',candidates):
    script='clean_replay.py' if a.real_wave else 'trace_odin.py'
    options=['--uncertain-related'] if a.real_wave=='related' else ['--local-asr'] if a.real_wave=='clean' else ['--case','uncertain']
    sys.argv=['/tmp/karaoke-sync-v2/odin/'+script,'--repo',str(a.repo),'--out',str(a.out),*options]
    runpy.run_path(sys.argv[0],run_name='__main__')
Path(str(a.out).replace('.json','-proposals.json')).write_text(json.dumps(proposals,ensure_ascii=False,indent=2))
print('PROPOSALS',proposals)
