from __future__ import annotations
from pathlib import Path
import json,sys,time,hashlib
import torch,torchcrepe
sys.path.insert(0,"/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python")
from backend.ai_worker import pitch
root=Path("/tmp/karaoke-sync-v4");out=root/"notes/real-pitch";out.mkdir(exist_ok=True)
cases=[]
for ref in (root/"audio-reference/frozen-reference.json",root/"audio-reference/frozen-additional-reference.json"):
    cases.extend(json.loads(ref.read_text())["cases"])
torch.set_num_threads(1)
model=Path(torchcrepe.__file__).parent/"assets/full.pth"
metadata={"scope":"Production pitch.pitch on6real externally annotated recording excerpts; existing installed CREPE full model. These are model pitch estimates, not manually verified per-frame F0 truth.","pitchSourceSha256":hashlib.sha256(Path(pitch.__file__).read_bytes()).hexdigest(),"crepeModelSha256":hashlib.sha256(model.read_bytes()).hexdigest(),"threads":1,"cases":[]}
for case in cases:
    output=out/(case["case"]+".json")
    if output.exists():
        raise RuntimeError("Do not silently overwrite pitch evidence")
    start=time.perf_counter();result=pitch.pitch(Path(case["audioPath"]));elapsed=time.perf_counter()-start
    output.write_text(json.dumps(result,ensure_ascii=False))
    row={"case":case["case"],"path":str(output),"audioPath":case["audioPath"],"audioSha256":case["audioSha256"],"duration":case["duration"],"elapsedSeconds":elapsed,"points":len(result["points"]),"strongActivePoints":sum(p["confidence"]>=.5 and p["audioActive"] for p in result["points"]),"outputSha256":hashlib.sha256(output.read_bytes()).hexdigest()}
    metadata["cases"].append(row);(out/"metadata.json").write_text(json.dumps(metadata,ensure_ascii=False,indent=2));print(json.dumps(row,ensure_ascii=False),flush=True)
