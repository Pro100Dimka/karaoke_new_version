from pathlib import Path
import numpy as np
from scipy import signal
from scipy.io import wavfile
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
root=Path(__file__).parent
fix=Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python/tests/fixtures')
sr,mix=wavfile.read(root/'sadsvit-nebo-public-stream-16k.wav'); assert sr==16000
cases=[]
with np.load(fix/'sadvit-phrase-ends.npz') as data:
 for key,offset,end in [('93',84,89),('129',116,121)]: cases.append((f'phrase-{key}',offset,end,data['vocal'+key],data['instrumental'+key]))
with np.load(fix/'sadvit-outro.npz') as data:cases.append(('outro',181,186,data['vocal'],data['instrumental']))
for name,start,end,voc,inst in cases:
 n=round((end-start)*sr);signals={'Vocal fixture':voc[:n],'Instrumental fixture':inst[:n],'Official public mixed stream':mix[round(start*sr):round(end*sr)]}
 fig,axes=plt.subplots(4,1,figsize=(15,12),sharex=True)
 for i,(label,s) in enumerate(signals.items()):
  fr,t,z=signal.stft(s,fs=sr,nperseg=1024,noverlap=896)
  db=20*np.log10(np.maximum(abs(z),1e-8))
  axes[i].pcolormesh(start+t,fr,db,vmin=-90,vmax=-20,cmap='magma',shading='auto');axes[i].set_ylim(0,5000);axes[i].set_ylabel(label+'\nHz')
  axes[i].grid(alpha=.15)
 for label,s in signals.items():
  frames=np.sqrt(np.mean(s[:len(s)//160*160].reshape(-1,160)**2,axis=1))
  axes[3].plot(start+(np.arange(len(frames))+.5)/100,20*np.log10(np.maximum(frames,1e-8)),label=label,lw=1)
 axes[3].set_ylim(-85,-5);axes[3].legend();axes[3].set_ylabel('10ms RMS, dBFS');axes[3].grid();axes[3].set_xlabel('Original track time, seconds (source match verified)')
 axes[3].set_xticks(np.arange(start,end+.001,.2));axes[3].set_xlim(start,end)
 fig.suptitle('SadSvit: '+name+' — signal-only inspection, algorithm timing not overlaid');fig.tight_layout();fig.savefig(root/(name+'-signal.png'));plt.close(fig)
 print(name)
