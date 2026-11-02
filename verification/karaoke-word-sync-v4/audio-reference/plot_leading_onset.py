from pathlib import Path
import numpy as np
from scipy import signal
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
root=Path(__file__).parent
p=Path('/tmp/karaoke-sync-v4/gtsinger-baseline/control_0003/acoustic-cache.npz')
f=np.load(p);x=f['audio'][:round(1.8*16000)];sr=16000
fig,axes=plt.subplots(3,1,figsize=(14,9),sharex=True)
axes[0].plot(np.arange(len(x))/sr,x,lw=.4);axes[0].set_ylabel('PCM amplitude')
fr,t,z=signal.stft(x,fs=sr,nperseg=1024,noverlap=944)
axes[1].pcolormesh(t,fr,20*np.log10(np.maximum(abs(z),1e-8)),vmin=-95,vmax=-25,shading='auto',cmap='magma');axes[1].set_ylim(0,6000);axes[1].set_ylabel('Hz')
chunk=160;rms=np.sqrt((x[:len(x)//chunk*chunk].reshape(-1,chunk)**2).mean(axis=1));axes[2].plot((np.arange(len(rms))+.5)/100,20*np.log10(np.maximum(rms,1e-8)),label='10ms RMS');axes[2].set_ylabel('dBFS');axes[2].set_ylim(-80,0)
for a in axes:
 a.axvline(.96,color='cyan',ls='--',lw=1,label='External annotated onset0.96');a.axvline(.12,color='red',ls=':',lw=1,label='Raw CTCfirstv0.12');a.axvline(1.08,color='green',ls=':',lw=1,label='CTCnextd1.08');a.grid(alpha=.2)
axes[0].legend();axes[-1].set_xlabel('Seconds in original clip');axes[-1].set_xlim(0,1.8)
fig.suptitle('Control0003: suddenly/вдруг — false leading CTCtoken in stationary background');fig.tight_layout();fig.savefig(root/'leading-onset-audit.png')
