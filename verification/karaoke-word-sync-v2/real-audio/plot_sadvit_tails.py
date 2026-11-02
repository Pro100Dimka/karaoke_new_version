from pathlib import Path
import json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy import signal
from scipy.io import wavfile
OUT=Path('/tmp/karaoke-sync-v2/real-audio');data=json.loads((OUT/'sadvit-tail-trace.json').read_text())
for case in data['cases']:
 off=case['offset'];end=off+case['final']['end'];lo=off+case['rawCore']['start']-.2;hi=end+.6
 with np.load(case['sourceArrayFile']) as f:v=f['vocal'];b=f['instrumental']
 fig,axs=plt.subplots(5,1,figsize=(13,12),sharex=True,layout='constrained')
 idx=np.arange(max(0,round((lo-off)*16000)),min(len(v),round((hi-off)*16000)))
 axs[0].plot(off+idx/16000,v[idx],lw=.3,label='Vocal stem');axs[0].plot(off+idx/16000,b[idx],lw=.25,alpha=.4,label='Instrumental stem');axs[0].legend(loc='upper right');axs[0].set_ylabel('Amplitude')
 for ax,a,title in [(axs[1],v,'Vocal spectrum'),(axs[2],b,'Instrumental spectrum')]:
  freq,t,z=signal.stft(a,16000,nperseg=512,noverlap=432);t=t+off;sel=(t>=lo)&(t<=hi)
  ax.pcolormesh(t[sel],freq,20*np.log10(np.maximum(abs(z[:,sel]),1e-7)),vmin=-65,vmax=-15,cmap='magma',shading='auto');ax.set_ylim(0,6000);ax.set_ylabel(title+'\nHz')
 rows=case['rows'];t=[r['t'] for r in rows]
 for key,color in [('speechProbability','tab:blue'),('smoothDominance','tab:orange'),('coherence','tab:green')]:axs[3].plot(t,[r[key] for r in rows],label=key,color=color,lw=1.3)
 axs[3].axhline(.5,linestyle=':',color='gray');axs[3].set_ylim(0,1);axs[3].legend(loc='upper right',ncols=3,fontsize=8);axs[3].set_ylabel('Source evidence')
 for key,color in [('periodicity','tab:blue'),('harmonicDistance','tab:purple'),('continued','black')]:axs[4].plot(t,[r[key] for r in rows],label=key,color=color,lw=1.1)
 axs[4].axhline(case['harmonicRadius95Percentile'],ls=':',label='core radius',color='tab:red');axs[4].legend(loc='upper right',ncols=4,fontsize=8);axs[4].set_ylim(0,1.05);axs[4].set_ylabel('Continuation')
 for ax in axs:
  ax.axvspan(*case['referenceEnd'],color='cyan',alpha=.12);ax.axvline(end,color='red',lw=1.2);ax.set_xlim(lo,hi);ax.grid(axis='x',alpha=.15)
 axs[-1].set_xlabel('Absolute source seconds; cyan = prior uncertain referenceEnd range, red = current computed end')
 fig.suptitle(f"SadSvit {case['case']}: actual stems and production stage evidence (not listened phoneme labels)")
 fig.savefig(OUT/f"sadvit-tail-{case['case']}.png",dpi=150);plt.close(fig)
 for name,a in [('vocal',v),('reconstructed-sum',v+b)]:wavfile.write(OUT/f"sadvit-tail-{case['case']}-{name}.wav",16000,a[idx].astype(np.float32))
print('Created three stage figures and six exact-sample review excerpts.')
