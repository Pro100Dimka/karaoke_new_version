"""One unchanged production CREPE full extraction on the saved real-vocal fixture."""
from pathlib import Path
from hashlib import sha256
from unittest.mock import patch
from datetime import datetime, timezone
import json, os, sys, time
import numpy as np
import torch
ROOT=Path('/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct')
OUT=Path('/tmp/karaoke-sync-v2/real-audio')
output=OUT/'clean_entry-pitch-points.json'
if output.exists():
    raise SystemExit('Existing pitch output preserved; this is a single-run extraction.')
sys.path.insert(0,str(ROOT/'python'))
from backend.ai_worker import pitch as worker
import torchcrepe
weights=Path(torchcrepe.__file__).parent/'assets'/'full.pth'
if not weights.is_file():
    raise SystemExit('Bundled CREPE full weights absent; no model download allowed.')
with np.load(ROOT/'python/tests/fixtures/wildways-verse-entry.npz') as f:
    vocal=f['clean_entry_vocal'].astype(np.float32)
input_sha=sha256(vocal.tobytes()).hexdigest()
torch.set_num_threads(1)
torch.set_num_interop_threads(1)
started=time.perf_counter()
with patch.object(worker,'read_mono',lambda *_:vocal), patch.object(worker,'device',lambda:'cpu'):
    result=worker.pitch(Path('fixture-clean_entry-vocal.wav'))
elapsed=time.perf_counter()-started
output.write_text(json.dumps(result,ensure_ascii=False,indent=2))
meta={
 'createdAtUtc':datetime.now(timezone.utc).isoformat(),
 'sourceFixture':str(ROOT/'python/tests/fixtures/wildways-verse-entry.npz'),
 'sourceArray':'clean_entry_vocal','sourceSamples':len(vocal),'sampleRate':16000,
 'vocalFloat32Sha256':input_sha,'inputUnchanged':input_sha==sha256(vocal.tobytes()).hexdigest(),
 'pitchCodeSha256':sha256(Path(worker.__file__).read_bytes()).hexdigest(),
 'model':'torchcrepe full','weightsPath':str(weights),'weightsSha256':sha256(weights.read_bytes()).hexdigest(),
 'device':'cpu','torchThreads':torch.get_num_threads(),'interopThreads':torch.get_num_interop_threads(),
 'extractionRuns':1,'durationSeconds':elapsed,'pointCount':len(result['points']),
 'pitchFileSha256':sha256(output.read_bytes()).hexdigest(),
 'confidentFrames':sum(p['confidence']>=.5 and p['audioActive'] for p in result['points']),
 'method':'Production pitch.pitch unchanged: CREPE full inference, decoder, audio activity and median confidence filtering; only read_mono supplied fixture samples and device selected CPU.',
 'limitations':['Model-derived pitch measurements; not independently manually annotated F0 truth.','Runtime is one cold pitch extraction including model load; not a before/after performance benchmark.']}
(OUT/'clean_entry-pitch-metadata.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2))
print(json.dumps(meta,ensure_ascii=False,indent=2))
