from pathlib import Path
from hashlib import sha256
import sys,json,numpy as np
sys.path.insert(0,"/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python")
from backend.ai_worker import ctc,timing
from backend.lyrics.domain import Word
rate=16000;t=np.arange(4*rate)/rate;rows=[]
for kind in ("quiet_dip","breath_after_release","pitched_echo_after_release"):
    amp=np.where((t>=1)&(t<(3 if kind=="quiet_dip" else 2)),.2,0.)
    if kind=="quiet_dip":amp[(t>=1.8)&(t<1.89)]=.001
    samples=amp*(np.sin(2*np.pi*220*t)+.3*np.sin(2*np.pi*440*t))
    later=(t>=2.11)&(t<2.6)
    if kind=="breath_after_release":samples[later]=np.random.default_rng(7).normal(0,.08,int(later.sum()))
    if kind=="pitched_echo_after_release":samples[later]=.12*np.sin(2*np.pi*220*t[later])
    samples=samples.astype(np.float32)
    word=ctc.AlignedWord("а",1,1.5 if kind=="quiet_dip" else 1.9,(1,),.9)
    result=ctc.with_sung_ends([word],samples)[0]
    period=timing.harmonic_evidence(samples,rate,160)[1]
    rows.append({"kind":kind,"start":result.start,"end":result.end,"diagnostics":result.diagnostics,"periodicityGapMedian":float(np.median(period[201:210]))})
items=[ctc.AlignedWord("а",1.0015,1.0016,(1.0015,),0.0),ctc.AlignedWord("я",2,3,(2,),.9)]
result=ctc.ordered(items)
for word in result:Word(word.text,word.start,word.end,(),word.letters).validate()
r={"ctcSha256":sha256(Path(ctc.__file__).read_bytes()).hexdigest(),"tailCases":rows,"roundedIntervals":[[w.start,w.end] for w in result]}
print(json.dumps(r,indent=2));Path("/tmp/karaoke-sync-v4/review/recheck-review.json").write_text(json.dumps(r,indent=2))
