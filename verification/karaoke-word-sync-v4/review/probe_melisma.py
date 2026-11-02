import sys,json
from pathlib import Path
from hashlib import sha256
import numpy as np
sys.path.insert(0,"/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python")
from backend.ai_worker import ctc
sr=16000;t=np.arange(4*sr)/sr;rows=[]
for mode in ("low_65hz","note_change","glissando","vibrato"):
    if mode=="low_65hz":f=np.full_like(t,65.)
    elif mode=="note_change":f=np.where(t<1.845,220.,330.)
    elif mode=="glissando":f=180+140*np.clip((t-1.8)/.09,0,1)
    else:f=220+12*np.sin(2*np.pi*6*t)
    phase=2*np.pi*np.cumsum(f)/sr
    amp=np.where((t>=1)&(t<3),.2,0.);amp[(t>=1.8)&(t<1.89)]=.001
    samples=(amp*(np.sin(phase)+.3*np.sin(2*phase))).astype(np.float32)
    word=ctc.AlignedWord("а",1,1.5,(1,),.9)
    result=ctc.with_sung_ends([word],samples)[0]
    rows.append({"mode":mode,"expectedGeneratedVocalEnd":3.,"outputEnd":result.end,"preserved":abs(result.end-3)<=.02})
result={"ctcSha256":sha256(Path(ctc.__file__).read_bytes()).hexdigest(),"cases":rows};Path("/tmp/karaoke-sync-v4/review/melisma-recheck.json").write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
