from pathlib import Path
import hashlib,json
import numpy as np
from scipy import signal
import soundfile as sf

root=Path(__file__).parent
fixtures=Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python/tests/fixtures')
source=root/'wildways-kilometry-public-stream-16k.wav'
samples,sr=sf.read(source,dtype='float64'); assert sr==16000
cases=[]
with np.load(fixtures/'wildways-verse-entry.npz') as f:
 for key,offset in [('clean_entry',57),('fast',57),('native_fast',57),('reply',110)]:
  cases.append((key,offset,f[f'{key}_vocal'].astype('float64')+f[f'{key}_instrumental'].astype('float64')))
rows=[]
for name,offset,template in cases:
 first=max(0,round((offset-2)*sr));last=min(len(samples),round((offset+len(template)/sr+2)*sr))
 search=samples[first:last]
 a=template-template.mean()
 # Exact normalized cross correlation across +/-2 seconds, no reference timestamps used to choose winner.
 corr=signal.correlate(search,a,mode='valid',method='fft')
 sums=np.concatenate(([0.],np.cumsum(search)))
 squares=np.concatenate(([0.],np.cumsum(search*search)))
 n=len(a); en=squares[n:]-squares[:-n]-(sums[n:]-sums[:-n])**2/n
 norm=corr/np.sqrt(np.maximum(en,1e-30)*np.dot(a,a))
 best=int(np.argmax(norm)); position=(first+best)/sr
 segment=samples[first+best:first+best+len(template)]
 rows.append({'case':name,'fixtureOffset':offset,'duration':len(template)/sr,'bestTrackOffset':position,'shiftSamples':first+best-round(offset*sr),'shiftMs':1000*(position-offset),'pearsonCorrelation':float(np.corrcoef(segment,template)[0,1])})
info=json.loads((root/'wildways-kilometry-public-stream.info.json').read_text())
result={'page':'https://soundcloud.com/wildways/kilometry','id':info['id'],'title':info['title'],'format':info['format_id'],'durationSeconds':len(samples)/sr,'audioSha256':hashlib.sha256((root/'wildways-kilometry-public-stream.m4a').read_bytes()).hexdigest(),'decodedSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'method':'Normalized cross-correlation of the unmodified fixture vocal+instrumental sum against official public mixed stream, searched +/-2 s. A reference waveform copy was decoded to mono16k; original source files were untouched. This establishes matching rendition and offset, not word/phone ground truth.','comparisons':rows}
(root/'wildways-source-comparison.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False,indent=2))
