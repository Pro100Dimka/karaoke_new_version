from __future__ import annotations
import argparse,json,sys,hashlib
from pathlib import Path
from math import isclose
sys.path.insert(0,"/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct/python")
from backend.ai.domain import PitchPoint,WordTiming
from backend.lyrics.codec import encode_document,decode_document
from backend.processing import algorithms as alg
p=argparse.ArgumentParser();p.add_argument("--after-dir",type=Path,required=True);p.add_argument("--output-dir",type=Path,required=True);a=p.parse_args();a.output_dir.mkdir(parents=True,exist_ok=True)
root=Path("/tmp/karaoke-sync-v4");cases=[]
for ref in (root/"audio-reference/frozen-reference.json",root/"audio-reference/frozen-additional-reference.json"):
    cases.extend(json.loads(ref.read_text())["cases"])
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def owner(doc,time):
    return next((i for i,w in enumerate(doc.words) if any(n.start<=time<n.end for n in w.notes)),None)
rows=[];missing=[]
for case in cases:
    pitch_path=root/"notes/real-pitch"/(case["case"]+".json")
    after_path=a.after_dir/case["case"]/"payload.json"
    before_path=root/"gtsinger-baseline"/case["case"]/"payload.json"
    if not pitch_path.exists() or not after_path.exists():
        missing.append(case["case"]);continue
    points=json.loads(pitch_path.read_text())["points"]
    raw=tuple(PitchPoint(p["time"],p["frequency"],p["confidence"],p.get("audioActive")) for p in points)
    stable=alg.stabilize_pitch(raw)
    melody=alg.construct_document("global", "GTSinger",case["duration"],"а",[WordTiming("а",0,case["duration"],1)],stable,alg.MusicMetadata(None,None)).words[0].notes
    docs=[];exports=[]
    for name,path in (("v3",before_path),("v4",after_path)):
        payload=json.loads(path.read_text())["words"]
        words=tuple(WordTiming(w["text"],w["start"],w["end"],w["confidence"],tuple(w["letters"]),tuple(w["diagnostics"])) for w in payload)
        doc=alg.construct_document(case["case"],"GTSinger",case["duration"],case["lyrics"],words,stable,alg.MusicMetadata(None,None))
        for word in doc.words:
            expected=[(n.note,max(word.start,n.start),min(word.end,n.end)) for n in melody if n.start<word.end and n.end>word.start]
            assert [(n.note,n.start,n.end) for n in word.notes]==expected
        text=encode_document(doc);assert decode_document(text)==doc
        target=a.output_dir/case["case"]/name/"lyricsSync.json";target.parent.mkdir(parents=True,exist_ok=True);target.write_text(text)
        docs.append(doc);exports.append({"label":name,"path":str(target),"sha256":sha(target),"sourcePayloadSha256":sha(path),"notes":sum(len(w.notes) for w in doc.words),"contourPoints":sum(len(n.contour) for w in doc.words for n in w.notes)})
    lost=[];gained=[];reassigned=[]
    for point in stable:
        if point.confidence<.5 or point.audio_active is False:continue
        old,new=[owner(d,point.time) for d in docs]
        datum={"time":point.time,"frequency":point.frequency,"confidence":point.confidence,"beforeOwner":old,"afterOwner":new}
        if old is not None and new is None:lost.append(datum)
        elif old is None and new is not None:gained.append(datum)
        elif old!=new:reassigned.append(datum)
    frame_changes=[]
    for step in (.01,.005):
        before,after=[list(d.target_frames(step)) for d in docs];both=[(x,y) for x,y in zip(before,after,strict=True) if x[1] is not None and y[1] is not None]
        changed=[(x,y) for x,y in both if not isclose(x[1],y[1],abs_tol=1e-9)]
        frame_changes.append({"step":step,"commonPitchedFrames":len(both),"commonFramePitchDifferences":len(changed),"maxPitchDifferenceSemitones":max((abs(x[1]-y[1]) for x,y in changed),default=0.),"activityChanges":sum(x[2]!=y[2] for x,y in zip(before,after,strict=True))})
    rows.append({"case":case["case"],"pitchPath":str(pitch_path),"pitchSha256":sha(pitch_path),"pitchPoints":len(raw),"globalNoteCount":len(melody),"exports":exports,"allNotesAreExactGlobalMelodyIntersections":True,"codecRoundTrips":True,"lostStrongPitchPoints":lost,"gainedStrongPitchPoints":gained,"reassignedStrongPitchPoints":reassigned,"targetFrames":frame_changes})
r={"scope":"Production stabilize_pitch/construct_document/_word_with_notes/codec on exact same fresh CREPE full-model observations for both versions. F0 estimates are not independent manual truth. Note intersections/ownership/pitch changes reported explicitly; independent word labels are not used to manufacture pitch.","algorithmSourceSha256":sha(Path(alg.__file__)),"missingCases":missing,"cases":rows}
(a.output_dir/"note-comparison.json").write_text(json.dumps(r,ensure_ascii=False,indent=2))
for row in rows:print(row["case"],"notes",[x["notes"] for x in row["exports"]],"lost",len(row["lostStrongPitchPoints"]),"gained",len(row["gainedStrongPitchPoints"]),"reassigned",len(row["reassignedStrongPitchPoints"]))
print("missing",missing)
