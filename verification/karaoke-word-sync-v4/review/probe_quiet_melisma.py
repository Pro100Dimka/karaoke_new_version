from pathlib import Path
import sys,json,numpy as np
sys.path.insert(0,sys.argv[1])
from backend.ai_worker import ctc
rate=16000;t=np.arange(4*rate)/rate
voice=((t>=1)&(t<3)).astype(float)*.2
# Continuous voiced waveform, becoming 46dB quieter for90ms inside one held vowel.
# There is no silence, breath, new singer, or separate word in this construction.
voice[(t>=1.8)&(t<1.89)]=.001
samples=(voice*(np.sin(2*np.pi*220*t)+.3*np.sin(2*np.pi*440*t))).astype(np.float32)
w=ctc.AlignedWord("а",1,1.5,(1,),.9)
fixed=ctc.with_sung_ends([w],samples)[0]
print(json.dumps({"source":sys.argv[1],"input":{"start":w.start,"end":w.end},"actualGeneratedVocalEnd":3,"outputEnd":fixed.end,"diagnostics":fixed.diagnostics}))
