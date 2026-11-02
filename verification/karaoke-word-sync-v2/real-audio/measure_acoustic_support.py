"""Independent descriptive signal measurements; never reads CTC scores or aligner output.

These observations do not certify word/phoneme identities or provide listening ground truth.
"""
from pathlib import Path
from hashlib import sha256
import json
import numpy as np
from scipy.io import wavfile
from scipy import signal
ROOT=Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct')
OUT=Path('/tmp/karaoke-sync-v2/real-audio')
SR=16000
report={'method':'Raw float waveform, 10-ms nonoverlapping RMS, independent of CTC/ASR; intervals inspected in unannotated spectrogram. A trough/change does not identify a word without contextual inference.','listened':False,'measurements':[],'exactUncertainWaveMapping':False}
with np.load(ROOT/'python/tests/fixtures/wildways-verse-entry.npz') as f:
 for key in ['fast_vocal','native_fast_vocal','clean_entry_vocal']:
  a=f[key].astype(np.float64)
  frames=a[:len(a)//160*160].reshape(-1,160)
  rms=np.sqrt((frames**2).mean(axis=1));t=(np.arange(len(rms))+.5)*.01
  search=(t>=9.40)&(t<=9.49);idx=np.flatnonzero(search)[np.argmin(rms[search])]
  left=(t>=9.25)&(t<=9.39);right=(t>=9.51)&(t<=9.75)
  report['measurements'].append({'vocalArray':key,'arraySha256':sha256(f[key].tobytes()).hexdigest(),'durationSeconds':len(a)/SR,'troughFrameSeconds':[round(idx*.01,3),round((idx+1)*.01,3)],'troughRmsDbfs':float(20*np.log10(rms[idx])),'previousPlateauMedianDbfs':float(np.median(20*np.log10(rms[left]))),'followingPlateauMedianDbfs':float(np.median(20*np.log10(rms[right]))),'interpretation':'Strong acoustic articulation separates two voiced regions near9.44; plausible medial consonant in target word, not certified word-start.'})
 for k in ['clean_entry_vocal','clean_entry_instrumental']:
  a=f[k].astype(np.float32)[int(7.75*SR):int(10.35*SR)]
  wavfile.write(OUT/f'{k}-7.75-10.35.wav',SR,a)
 mix=(f['clean_entry_vocal'].astype(np.float32)+f['clean_entry_instrumental'].astype(np.float32))[int(7.75*SR):int(10.35*SR)]
 wavfile.write(OUT/'clean_entry-reconstructed-sum-7.75-10.35.wav',SR,mix)
report['referenceBoundaries']={'onset':{'humanMeasured':None,'acousticSeam':'No clear silence separates the preceding word and initial vowel. Exact seam around8.9–9.2 cannot be resolved confidently from the available spectra.','conditionalUpperBoundSeconds':9.49,'condition':'Assuming contextual identification of9.42–9.49 articulation as medial consonant/new vowel belonging to один. This is inference from source acoustics, not independent human ground truth.'},'end':{'humanMeasured':None,'limitation':'Continuous voiced transition into following words; no certified exact boundary.'}}
(OUT/'acoustic-support.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
