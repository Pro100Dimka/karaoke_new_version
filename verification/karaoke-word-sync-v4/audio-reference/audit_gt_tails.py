from pathlib import Path
import json
import numpy as np
from scipy import signal
from scipy.io import wavfile
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root=Path(__file__).parent
# WAV PCM24 decoded identically by scipy (left-justified int32); no audio rewriting.
cases=[('breathy-anya','Breathy_Group','0001',5.6,7.166,6.505),('control-anna','Control_Group','0000',3.25,4.75,4.441)]
output=[]
for name,group,number,start,end,published_end in cases:
 wav=root/'gtsinger'/'Аня Облонская'/group/(number+'.wav')
 sr,data=wavfile.read(wav);x=data.astype(float)/(2**31 if data.dtype==np.int32 else 2**15)
 if x.ndim>1:x=x.mean(axis=1)
 frame=round(.04*sr);hop=round(.005*sr)
 times=[];periodic=[];rms=[];flat=[];f0=[]
 for center in np.arange(round(start*sr),min(len(x),round(end*sr)),hop):
  seg=x[max(0,center-frame//2):min(len(x),center+frame//2)]
  if len(seg)<frame:continue
  seg=seg-seg.mean();ac=signal.correlate(seg,seg,mode='full',method='fft')[frame-1:]
  minlag=round(sr/1000);maxlag=round(sr/80)
  # normalized autocorrelation compensates unequal overlap lengths.
  e=np.concatenate(([0.],np.cumsum(seg*seg)))
  lags=np.arange(minlag,maxlag+1)
  corr=ac[lags]/np.sqrt(np.maximum((e[frame-lags]-e[0])*(e[frame]-e[lags]),1e-30))
  peaks,_=signal.find_peaks(corr)
  if len(peaks):peak=int(peaks[np.argmax(corr[peaks])]);p=float(corr[peak]);pitch=sr/lags[peak]
  else:p=0.;pitch=None
  spectrum=abs(np.fft.rfft(seg*np.hanning(frame)))**2
  freqs=np.fft.rfftfreq(frame,1/sr);select=(freqs>=300)&(freqs<=6000);spectrum=np.maximum(spectrum[select],1e-30)
  times.append(center/sr);periodic.append(p);rms.append(np.sqrt(np.mean(seg*seg)));flat.append(float(np.exp(np.mean(np.log(spectrum)))/np.mean(spectrum)));f0.append(pitch)
 t=np.array(times);pr=np.array(periodic);rms=np.array(rms);fl=np.array(flat)
 first=round(start*sr);last=min(len(x),round(end*sr));view=x[first:last]
 fr,st,z=signal.stft(view,fs=sr,nperseg=2048,noverlap=1808)
 fig,axes=plt.subplots(4,1,figsize=(14,11),sharex=True)
 axes[0].plot(np.arange(first,last)/sr,view,lw=.25);axes[0].set_ylabel('PCM amplitude')
 axes[1].pcolormesh(first/sr+st,fr,20*np.log10(np.maximum(abs(z),1e-8)),vmin=-95,vmax=-30,shading='auto',cmap='magma');axes[1].set_ylim(0,6000);axes[1].set_ylabel('Hz')
 axes[2].plot(t,20*np.log10(np.maximum(rms,1e-8)),label='40ms RMS');axes[2].set_ylabel('dBFS')
 axes[3].plot(t,pr,label='Normalized autocorrelation peak');axes[3].plot(t,fl,label='Spectral flatness 300–6000Hz');axes[3].set_ylim(0,1.05);axes[3].legend()
 for ax in axes:
  ax.axvline(published_end,c='cyan',ls='--',lw=1,label='Published external word end');ax.grid(alpha=.2)
 axes[-1].set_xlim(start,end);axes[-1].set_xlabel('Seconds in unmodified dataset clip; cyan=external annotation, not algorithm')
 fig.suptitle(name+' — waveform-only tail audit, no CTC/ASR');fig.tight_layout();fig.savefig(root/(name+'-audit.png'));plt.close(fig)
 # Broad predeclared audit bins bracket the disputed tail, without declaring a hard true end.
 bins=([(5.945,6.3),(6.3,6.45),(6.45,6.505),(6.505,6.6),(6.6,6.8),(6.8,7.1)] if group=='Breathy_Group' else [(3.9,4.2),(4.2,4.31),(4.31,4.4),(4.4,4.441),(4.441,4.5),(4.5,4.59)])
 stats=[]
 for a,b in bins:
  m=(t>=a)&(t<b)
  if not m.any():continue
  stats.append({'start':a,'end':b,'medianRmsDbfs':float(np.median(20*np.log10(np.maximum(rms[m],1e-8)))),'medianAutocorrelation':float(np.median(pr[m])),'maxAutocorrelation':float(np.max(pr[m])),'medianFlatness':float(np.median(fl[m]))})
 output.append({'case':name,'audioPath':str(wav),'publishedEnd':published_end,'frameMs':40,'hopMs':5,'listenedByAgent':False,'usesCTC':False,'bins':stats,'curve':{'time':times,'autocorrelation':periodic,'rms':rms.tolist(),'flatness':flat,'dominantPeriodHz':f0}})
(root/'independent-tail-features.json').write_text(json.dumps(output,ensure_ascii=False,indent=2))
for c in output: print(c['case'],json.dumps(c['bins'],indent=2))
