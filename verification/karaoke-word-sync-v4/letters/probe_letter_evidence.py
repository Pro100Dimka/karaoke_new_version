from __future__ import annotations
from pathlib import Path
from dataclasses import asdict, replace
import json, sys
import numpy as np
import torch
sys.path.insert(0, "/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python")
from backend.ai_worker import ctc, timing
from torchaudio.pipelines import MMS_FA
root=Path("/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct")
out=Path("/tmp/karaoke-sync-v4/letters")
def evidence(word,scores,activity,heard):
    index=ctc._sung_tail_index(word)
    crop=scores[max(0,int(word.start/.02)):round(word.end/.02)]
    off=max(0,int(word.start/.02))*.02
    original=ctc.align_words(crop,.02,[word.text],off)[0]
    bounded=ctc.align_words(crop,.02,[word.text],off,bounded_end=True)[0]
    shift=word.letters[0]-original.letters[0]
    token=ctc._character_tokens(word.text)[index][0]
    probabilities=[float(scores[round(w.letters[index]/.02),token].exp()) for w in (original,bounded)]
    return {"input":asdict(word),"local":asdict(original),"bounded":asdict(bounded),
      "supported":ctc._sung_tail_supported(word,index,None,heard,activity,.02),
      "prefixDisagreementLocalVsBounded":[round(abs(a-b),9) for a,b in zip(original.letters[:index],bounded.letters[:index])],
      "storedVsLocalShifted":[round(abs(a+shift-b),9) for a,b in zip(original.letters,word.letters)],
      "tailProbability":probabilities,
      "output":asdict(ctc.with_sung_letters([word],scores,.02,activity,{0:heard})[0])}
with np.load(root/"python/tests/fixtures/wildways-verse-entry.npz") as f:
    scores=torch.from_numpy(f["clean_entry_scores"])
    vocal=f["clean_entry_vocal"].astype(np.float32)
    backing=f["clean_entry_instrumental"].astype(np.float32)
activity=timing.singing_frames(vocal,backing,16000,160)
word=ctc.AlignedWord("один",8.62,9.94,(8.62,9.36,9.38,9.40),.0019060261965933023)
real=evidence(word,scores,activity,(8.62,9.94))
size=len(MMS_FA.get_dict(star=None))
p=torch.full((85,size),.2/(size-1));p[:,0]=.8
tokens=[x for c in ctc._character_tokens("один") for x in c]
for frame,token in zip((10,12,30,60),tokens):
    p[frame]=.05/(size-1);p[frame,token]=.95
synth=ctc.AlignedWord("один",.2,1.22,(.2,.24,.28,.30),.10)
synthetic=evidence(synth,p.log(),np.ones(170,bool),(.2,1.22))
# Genuine sustained final nasal: high nasal evidence through its known interval.
pn=torch.full((85,size),.2/(size-1));pn[:,0]=.8
tn=[x for c in ctc._character_tokens("дом") for x in c]
for frame,token in zip((10,12,14),tn):
    pn[frame]=.05/(size-1);pn[frame,token]=.95
pn[14:61]=.05/(size-1);pn[14:61,tn[-1]]=.95
nasal=replace(ctc.align_words(pn.log(),.02,["дом"])[0], end=1.22)
result={"realCleanOdin":real,"syntheticJointPrefix":synthetic,"syntheticHeldNasal":evidence(nasal,pn.log(),np.ones(170,bool),(.2,1.22)),"notes":"Real waveform/CTC paired; phoneme timing not independently labelled. Synthetic known emissions are construction truth, not recorded voice."}
(out/"before-letter-evidence.json").write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(result,ensure_ascii=False,indent=2))
