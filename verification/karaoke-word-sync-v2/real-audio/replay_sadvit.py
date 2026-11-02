"""Replay bundled real Ukrainian SadSvit excerpts through actual CTC/tail code.

Only the outro has cached CTC emissions; phrase ends have pinned full-song CTC cores.
Reference intervals are prior independent acoustic brackets, explicitly not listening-certified.
"""
from pathlib import Path
import argparse, json, sys, time, hashlib
from dataclasses import asdict
import numpy as np
import torch

def sha(b):return hashlib.sha256(b).hexdigest()
def bracket(at, span):
    lo,hi=span
    return {'signedDistanceToIntervalMs':1000*(at-lo if at<lo else at-hi if at>hi else 0.),'possibleSignedErrorRangeMs':[1000*(at-hi),1000*(at-lo)],'withinInterval':lo<=at<=hi}
def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('repo_python',type=Path);ap.add_argument('output',type=Path);ap.add_argument('--label',required=True);args=ap.parse_args()
    sys.path.insert(0,str(args.repo_python))
    from backend.ai_worker import ctc,timing
    torch.set_num_threads(1);torch.set_num_interop_threads(1)
    files={name:Path(module.__file__) for name,module in [('ctc',ctc),('timing',timing)]}
    before_hashes={k:sha(p.read_bytes()) for k,p in files.items()}
    fixtures=args.repo_python/'tests'/'fixtures';cases=[]
    with np.load(fixtures/'sadvit-phrase-ends.npz') as f:
        metadata=json.loads(str(f['metadata']))
        for case in metadata['cases']:
            offset,key=case['offset'],case['key'];src=case['word']
            raw=ctc.AlignedWord(src['text'],src['start']-offset,src['end']-offset,tuple(t-offset for t in src['letters']),src['score'])
            vocal=f['vocal'+key].astype(np.float32);backing=f['instrumental'+key].astype(np.float32)
            start=time.perf_counter();final=ctc.with_sung_ends([raw],vocal,instrumental=backing)[0];elapsed=time.perf_counter()-start
            cases.append(make_row('phrase-'+key,offset,raw,final,vocal,backing,case['referenceEnd'],elapsed,'Pinned full-song CTC core; this fixture has no CTC emissions to rerun. Actual with_sung_ends invoked with real vocal+instrumental.',case))
    with np.load(fixtures/'sadvit-outro.npz') as f:
        metadata_outro=json.loads(str(f['metadata']));offset=float(metadata_outro['sourceStartSeconds'])
        vocal=f['vocal'].astype(np.float32);backing=f['instrumental'].astype(np.float32);scores=torch.from_numpy(f['scores'])
        start=time.perf_counter();raw=ctc.align_words(scores,float(f['frame_seconds']),['навіки'])[0];final=ctc.with_sung_ends([raw],vocal,instrumental=backing)[0];elapsed=time.perf_counter()-start
        row=make_row('outro',offset,raw,final,vocal,backing,[182.3,182.6],elapsed,'Actual align_words on cached MMS emissions, then actual with_sung_ends on real vocal+instrumental.',metadata_outro)
        row['emissionSha256']=sha(scores.numpy().tobytes());row['emissionDurationSeconds']=scores.shape[0]*float(f['frame_seconds']);row['userReportedEndUpperBound']=183.;row['rawAndFinalBeforeUserUpperBound']=[raw.end+offset<183,final.end+offset<183];cases.append(row)
    after_hashes={k:sha(p.read_bytes()) for k,p in files.items()}
    result={'label':args.label,'scope':'Three real Ukrainian excerpts; no full-song ASR/MMS inference, no model/song download, no manual listening in this run.','sourceHashes':before_hashes,'sourceUnchangedDuringReplay':before_hashes==after_hashes,'torchThreads':torch.get_num_threads(),'cases':cases,'referenceLimitations':['No independent start labels, so start error is null.','Phrase metadata explicitly listened:false; endpoint brackets are prior acoustic observations, not precise phoneme truth.','Outro waveform is6s while emission timeline is38.86s. Report does not claim waveform beyond the stored excerpt.'],'priorSourceMetadata':metadata['source']}
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps({'label':args.label,'sourceUnchanged':result['sourceUnchangedDuringReplay'],'cases':[{k:v for k,v in c.items() if k in ['case','text','rawAbsolute','finalAbsolute','rawEndVsAcousticInterval','finalEndVsAcousticInterval','endReferenceInterval','elapsedSeconds']} for c in cases]},ensure_ascii=False,indent=2))
def make_row(name,offset,raw,final,vocal,backing,ref,elapsed,method,metadata):
    def absolute(w):return {'start':w.start+offset,'end':w.end+offset,'letters':[t+offset for t in w.letters]}
    return {'case':name,'text':raw.text,'language':'Ukrainian','offset':offset,'durationSeconds':len(vocal)/16000,'vocalSha256':sha(vocal.tobytes()),'instrumentalSha256':sha(backing.tobytes()),'rawCore':asdict(raw),'final':asdict(final),'rawAbsolute':absolute(raw),'finalAbsolute':absolute(final),'endReferenceInterval':ref,'startReference':None,'startErrorMs':None,'rawEndVsAcousticInterval':bracket(raw.end+offset,ref),'finalEndVsAcousticInterval':bracket(final.end+offset,ref),'startPreserved':raw.start==final.start,'lettersPreserved':raw.letters==final.letters,'elapsedSeconds':elapsed,'method':method,'referenceMetadata':metadata}
if __name__=='__main__':main()
