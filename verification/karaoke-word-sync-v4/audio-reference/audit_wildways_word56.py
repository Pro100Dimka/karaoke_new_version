"""CTC-independent inspection of raw public recording and Demucs stems."""
from hashlib import sha256
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from scipy import signal
from scipy.io import wavfile

ROOT = Path(__file__).parent
STEMS = Path('/tmp/karaoke-sync-v4/full-pipeline/cache-mode-final-smoke')
START, END = 63.5, 66.5
sources = {'vocal': STEMS/'vocals.wav', 'backing': STEMS/'instrumental.wav',
           'original_mix': ROOT/'wildways-whole-song-audit-original.wav'}
curves, samples, provenance = {}, {}, {}
for name, path in sources.items():
    rate, pcm = wavfile.read(path)
    offset = 0 if name == 'original_mix' else round(START * rate)
    audio = pcm[offset:offset+round((END-START)*rate)].astype(np.float64)
    if np.issubdtype(pcm.dtype, np.integer):
        audio /= -np.iinfo(pcm.dtype).min
    audio = audio.mean(axis=1) if audio.ndim > 1 else audio
    samples[name] = audio
    provenance[name] = {'path':str(path), 'sha256':sha256(path.read_bytes()).hexdigest(),
                        'sampleRate':rate, 'offsetSeconds':START}
    # 40-ms windows avoid assuming a stationary long note. Each window lies
    # wholly in the inspected raw signal; no model word/letter marks are read.
    size, hop = round(.04*rate), round(.01*rate)
    lags = np.arange(round(rate/700), round(rate/70))
    times, rms, periodicity, f0, high_low, flux = [], [], [], [], [], []
    previous = None
    for first in range(0, len(audio)-size+1, hop):
        frame = audio[first:first+size].copy()
        frame -= frame.mean()
        powers = abs(np.fft.rfft(frame*np.hanning(size)))**2
        frequencies = np.fft.rfftfreq(size, 1/rate)
        correlations = signal.correlate(frame, frame, mode='full', method='fft')[size-1:]
        energy = np.concatenate(([0.0],np.cumsum(frame**2)))
        denominator=np.sqrt((energy[size-lags])*(energy[size]-energy[lags]))
        normalized=correlations[lags]/np.maximum(denominator,1e-20)
        peak=int(np.argmax(normalized))
        times.append(START+(first+size/2)/rate)
        rms.append(float(20*np.log10(max(np.sqrt(np.mean(frame**2)),1e-12))))
        periodicity.append(float(normalized[peak]));f0.append(float(rate/lags[peak]))
        high_low.append(float(powers[(frequencies>=3000)&(frequencies<10000)].sum()/max(powers[(frequencies>=100)&(frequencies<3000)].sum(),1e-30)))
        spectrum=np.sqrt(powers);spectrum/=max(np.linalg.norm(spectrum),1e-30)
        flux.append(float(np.linalg.norm(np.maximum(spectrum-previous,0))) if previous is not None else 0.)
        previous=spectrum
    curves[name]={'time':times,'rmsDbfs':rms,'periodicity40ms':periodicity,
                  'strongestAutocorrelationF0':f0,'highLowRatio':high_low,'spectralFlux':flux}

for title, left, right in [('context',63.5,66.5),('release',64.9,65.9)]:
    fig,axes=plt.subplots(5,1,figsize=(16,14),sharex=True)
    for ax,name in zip(axes[:3],sources):
        audio=samples[name]
        f,t,z=signal.stft(audio,fs=rate,nperseg=2048,noverlap=1768)
        ax.pcolormesh(START+t,f,20*np.log10(np.maximum(abs(z),1e-12)),vmin=-100,vmax=-30,shading='auto',cmap='magma')
        ax.set_ylim(0,7000);ax.set_ylabel(f'{name}\nHz')
    for name,curve in curves.items():
        axes[3].plot(curve['time'],curve['rmsDbfs'],label=name)
    axes[3].set_ylabel('RMS / dBFS');axes[3].legend()
    for name in ['vocal','backing']:
        axes[4].plot(curves[name]['time'],curves[name]['periodicity40ms'],label=name)
    axes[4].set_ylabel('Normalized periodicity');axes[4].legend()
    axes[4].set_xticks(np.arange(left,right+.0001,.05 if title=='release' else .1))
    for ax in axes: ax.grid(alpha=.25)
    axes[-1].set_xlim(left,right);axes[-1].set_xlabel('Original full recording time / s; no CTC or model word overlays')
    fig.suptitle('Wildways: independent raw spectrum and stem audit')
    fig.tight_layout();fig.savefig(ROOT/f'wildways-word56-{title}.png');plt.close(fig)

bins=[]
for left in np.arange(64.9,65.9,.05):
    right=left+.05;row={'start':round(float(left),3),'end':round(float(right),3)}
    for name,curve in curves.items():
        mask=(np.array(curve['time'])>=left)&(np.array(curve['time'])<right)
        row[name]={key:float(np.median(np.array(values)[mask])) for key,values in curve.items() if key!='time'}
    bins.append(row)
output={'usesModelPredictions':False,'listenedByAgent':False,'sources':provenance,'curves':curves,'bins':bins}
(ROOT/'wildways-word56-raw-audit.json').write_text(json.dumps(output,ensure_ascii=False,indent=2))
print(json.dumps(bins,indent=2))
