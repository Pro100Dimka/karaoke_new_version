from pathlib import Path
import json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy import signal
ROOT=Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python/tests/fixtures')
OUT=Path('/tmp/karaoke-sync-v2/real-audio')
SR=16000
with np.load(ROOT/'wildways-verse-entry.npz') as f:
    arrays={k:f[k].astype(np.float64) for k in ['clean_entry_vocal','clean_entry_instrumental','fast_vocal','native_fast_vocal']}
fig,ax=plt.subplots(5,1,figsize=(16,13),sharex=True,layout='constrained')
for name,color in [('clean_entry_vocal','tab:blue'),('fast_vocal','tab:orange'),('native_fast_vocal','tab:green')]:
    a=arrays[name]; a=a[int(7.75*SR):int(10.35*SR)]
    tm=7.75+np.arange(len(a))/SR
    ax[0].plot(tm,a,lw=.3,alpha=.55,label=name,color=color)
    frame=160; a=a[:len(a)//frame*frame];rms=np.sqrt(np.mean(a.reshape(-1,frame)**2,axis=1))
    ax[1].plot(7.755+np.arange(len(rms))*.01,20*np.log10(np.maximum(rms,1e-6)),label=name,lw=1.1,color=color)
ax[0].legend(loc='upper right');ax[0].set_ylabel('Amplitude');ax[1].set_ylabel('10 ms RMS (dBFS)')
for row,name in [(2,'clean_entry_vocal'),(3,'fast_vocal'),(4,'native_fast_vocal')]:
    a=arrays[name]
    freq,tt,z=signal.stft(a,SR,nperseg=512,noverlap=480)
    select=(tt>=7.75)&(tt<=10.35)&(tt<len(a)/SR)
    db=20*np.log10(np.maximum(np.abs(z[:,select]),1e-7))
    ax[row].pcolormesh(tt[select],freq,db,shading='auto',cmap='magma',vmin=-65,vmax=-20)
    ax[row].set_ylim(0,6000);ax[row].set_ylabel(name+'\nHz')
for a in ax:
    a.set_xlim(7.75,10.35);a.set_xticks(np.arange(7.8,10.4,.1));a.grid(axis='x',alpha=.25)
ax[-1].set_xlabel('Fragment seconds, nominal source offset 57 seconds; plots show waveforms only, no CTC/ASR boundaries')
fig.suptitle('Wildways entry: raw vocal waveforms and spectra around the questioned boundary')
fig.savefig(OUT/'odin-waveforms.png',dpi=180)
plt.close(fig)
# Larger spectrogram at phonetic transitions.
fig,ax=plt.subplots(3,1,figsize=(16,10),sharex=True,layout='constrained')
a=arrays['clean_entry_vocal'];lo,hi=8.4,10.1;idx=np.arange(int(lo*SR),int(hi*SR));ax[0].plot(idx/SR,a[idx],lw=.4)
for row,window in [(1,512),(2,1024)]:
 freq,tt,z=signal.stft(a,SR,nperseg=window,noverlap=window-32)
 select=(tt>=lo)&(tt<=hi)
 ax[row].pcolormesh(tt[select],freq,20*np.log10(np.maximum(np.abs(z[:,select]),1e-7)),shading='auto',cmap='magma',vmin=-65,vmax=-20)
 ax[row].set_ylim(0,4500);ax[row].set_ylabel(f'{window/SR*1000:.0f}ms STFT, Hz')
for a in ax:
 a.set_xlim(lo,hi);a.set_xticks(np.arange(lo,hi+.01,.05));a.grid(axis='x',alpha=.25)
ax[-1].set_xlabel('Fragment seconds; no forced aligner annotations')
fig.savefig(OUT/'odin-transition.png',dpi=200)
