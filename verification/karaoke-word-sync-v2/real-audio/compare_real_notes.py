"""Compare unchanged production note construction on two word payloads and one real CREPE track.

No inference. Never alters source pitch or payloads. The word payload may be a labelled prototype;
model pitch is not human F0 ground truth. CLI paths make this reusable for final production replay.
"""
from __future__ import annotations
import argparse, hashlib, json, math, sys
from dataclasses import asdict
from pathlib import Path
import numpy as np


def digest_bytes(b): return hashlib.sha256(b).hexdigest()
def digest_obj(obj): return digest_bytes(json.dumps(obj,sort_keys=True,separators=(',',':')).encode())
def read_words(obj): return obj.get('payload',obj).get('words',[])
def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repo-python',type=Path,required=True)
    ap.add_argument('--before',type=Path,required=True);ap.add_argument('--after',type=Path,required=True)
    ap.add_argument('--pitch',type=Path,required=True);ap.add_argument('--output',type=Path,required=True)
    ap.add_argument('--fixture',type=Path,required=True);ap.add_argument('--label',required=True)
    ap.add_argument('--comparison-status',choices=['prototype','production'],default='prototype')
    args=ap.parse_args();sys.path.insert(0,str(args.repo_python))
    from backend.ai.domain import WordTiming,PitchPoint
    from backend.processing import algorithms as alg
    from backend.lyrics.codec import decode_document,encode_document
    before_bytes=args.before.read_bytes();after_bytes=args.after.read_bytes();pitch_bytes=args.pitch.read_bytes()
    before=json.loads(before_bytes);after=json.loads(after_bytes)
    source_files={name:args.repo_python/path for name,path in {
        'algorithms':'backend/processing/algorithms.py','lyricsDomain':'backend/lyrics/domain.py',
        'lyricsCodec':'backend/lyrics/codec.py','ctc':'backend/ai_worker/ctc.py',
        'speech':'backend/ai_worker/speech.py','timing':'backend/ai_worker/timing.py',
        'wordGuidance':'backend/ai_worker/word_guidance.py',
    }.items()}
    source_hashes={name:digest_bytes(path.read_bytes()) for name,path in source_files.items()}
    pitch_raw=json.loads(pitch_bytes)['points']
    raw=tuple(PitchPoint(p['time'],p['frequency'],p['confidence'],p.get('audioActive')) for p in pitch_raw)
    stable=alg.stabilize_pitch(raw)
    stable_snapshot=tuple(asdict(p) for p in stable)
    duration=float(before.get('inputs',{}).get('duration',16.0))
    with np.load(args.fixture) as data: vocal=data['clean_entry_vocal'].astype(np.float32)
    rms=[]
    for p in stable:
        lo=max(0,round(p.time*16000)-80);hi=min(len(vocal),lo+160)
        rms.append(float(np.sqrt(np.mean(vocal[lo:hi]**2))) if hi>lo else 0.)
    active_rms=[level for p,level in zip(stable,rms) if p.audio_active and p.confidence>=.5]
    quiet_cut=float(np.quantile(active_rms,.25))
    docs=[];word_payloads=[read_words(x) for x in [before,after]]
    for words in word_payloads:
        timings=tuple(WordTiming(w['text'],w['start'],w['end'],w.get('confidence',w.get('score',0)),tuple(w.get('letters',())),tuple(w.get('diagnostics',()))) for w in words)
        docs.append(alg.construct_document('Wildways excerpt','fixture',duration,' '.join(w['text'] for w in words),timings,stable,alg.MusicMetadata(None,None)))
    global_notes=alg._notes_from_points(stable,0,duration)
    source={round(p.time,8):p for p in stable}
    def rows(doc):
        out=[]
        for i,w in enumerate(doc.words):
            row={'index':i,'text':w.text,'start':w.start,'end':w.end,'duration':w.end-w.start,'letters':list(w.letters),'notes':[]}
            for n in w.notes:
                absolute=[{'time':round(n.start+f*(n.end-n.start),8),'midi':n.note+off,'confidence':c} for f,off,c in n.contour]
                row['notes'].append({'midiNote':n.note,'start':n.start,'end':n.end,'duration':n.end-n.start,'absoluteContour':absolute})
            row['noteSpanSeconds']=sum(n.end-n.start for n in w.notes)
            row['contourPointCount']=sum(len(n.contour) for n in w.notes)
            row['confidentContourPointCount']=sum(p['confidence']>=.5 for n in row['notes'] for p in n['absoluteContour'])
            out.append(row)
        return out
    rows_before,rows_after=map(rows,docs)
    def flatten(rows):
        return {p['time']:{**p,'wordIndex':w['index'],'wordText':w['text']} for w in rows for n in w['notes'] for p in n['absoluteContour']}
    maps=[flatten(x) for x in [rows_before,rows_after]]
    common=maps[0].keys()&maps[1].keys()
    ownership=[{'time':t,'before':maps[0][t]['wordText'],'after':maps[1][t]['wordText'],'midiBefore':maps[0][t]['midi'],'midiAfter':maps[1][t]['midi']} for t in sorted(common) if maps[0][t]['wordIndex']!=maps[1][t]['wordIndex']]
    frame_lists=[list(d.target_frames()) for d in docs]
    frame_changes=[]
    for a,b in zip(*frame_lists,strict=True):
        equal_pitch=(a[1] is None and b[1] is None) or (a[1] is not None and b[1] is not None and abs(a[1]-b[1])<1e-9)
        if not equal_pitch or a[2]!=b[2]: frame_changes.append({'time':a[0],'beforePitch':a[1],'afterPitch':b[1],'beforeActive':a[2],'afterActive':b[2]})
    added_pitch_frames=[row for row in frame_changes if row['beforePitch'] is None and row['afterPitch'] is not None]
    removed_pitch_frames=[row for row in frame_changes if row['beforePitch'] is not None and row['afterPitch'] is None]
    changed_existing_pitch_frames=[row for row in frame_changes if row['beforePitch'] is not None and row['afterPitch'] is not None and abs(row['beforePitch']-row['afterPitch'])>=1e-9]
    added_activity_frames=[row for row in frame_changes if not row['beforeActive'] and row['afterActive']]
    removed_activity_frames=[row for row in frame_changes if row['beforeActive'] and not row['afterActive']]
    quiet_endings=[]
    for wb,wa in zip(rows_before,rows_after,strict=True):
        # An extended endpoint need not have identical notes. Its already-covered
        # quiet ending samples must remain at the same absolute time and owner.
        if wb['start']!=wa['start'] or wa['end']<wb['end']:continue
        at=[round(p.time,8) for p,l in zip(stable,rms) if max(wb['start'],wb['end']-.2)<=p.time<wb['end'] and p.audio_active and p.confidence>=.5 and l<=quiet_cut]
        if at:
            covered_before=[t for t in at if t in maps[0] and maps[0][t]['wordIndex']==wb['index']]
            covered_after=[t for t in at if t in maps[1] and maps[1][t]['wordIndex']==wa['index']]
            quiet_endings.append({'index':wb['index'],'text':wb['text'],'beforeWordEnd':wb['end'],'afterWordEnd':wa['end'],'lowEnergyConfidentPointTimes':at,'notesIdentical':wb['notes']==wa['notes'],'beforeCoveredPointTimes':covered_before,'afterCoveredPointTimes':covered_after,'previouslyCoveredPointsRetained':set(covered_before)<=set(covered_after)})
    def source_consistent(mapping):
        for t,p in mapping.items():
            src=source[t]
            if src.frequency>0 and abs(p['midi']-(69+12*math.log2(src.frequency/440)))>1e-9:return False
            expected_conf=src.confidence if src.frequency>0 and src.audio_active is not False else 0.
            if p['confidence']!=expected_conf:return False
        return True
    def expected_intersections(doc):
        for word in doc.words:
            expected=[(n.note,max(word.start,n.start),min(word.end,n.end)) for n in global_notes if n.start<word.end and n.end>word.start]
            if expected!=[(n.note,n.start,n.end) for n in word.notes]:return False
        return True
    checks={
      'pitchInputUnchanged':stable_snapshot==tuple(asdict(p) for p in stable) and pitch_bytes==args.pitch.read_bytes(),
      'wordPayloadFilesUnchanged':before_bytes==args.before.read_bytes() and after_bytes==args.after.read_bytes(),
      'beforeAfterReplayInputsIdentical':before.get('inputs')==after.get('inputs'),
      'sourceFilesUnchangedDuringComparison':source_hashes=={name:digest_bytes(path.read_bytes()) for name,path in source_files.items()},
      'afterReplayCtcMatchesCurrentSource':after.get('sourceHashes',{}).get('ctc')==source_hashes['ctc'],
      'allWordBoundariesAndLettersPreserved':[all((w.text,w.start,w.end,tuple(w.letters))==(p['text'],p['start'],p['end'],tuple(p.get('letters',()))) for w,p in zip(d.words,payload,strict=True)) for d,payload in zip(docs,word_payloads,strict=True)],
      'allNotesExactlyGlobalMelodyWordIntersections':list(map(expected_intersections,docs)),
      'allContourAbsoluteTimesAndPitchMatchSameStabilizedInput':list(map(source_consistent,maps)),
      'codecRoundTrip':[decode_document(encode_document(d))==d for d in docs],
      'commonContourMaxPitchDifferenceSemitones':max((abs(maps[0][t]['midi']-maps[1][t]['midi']) for t in common),default=0.),
      'allUnchangedWordNotesIdentical':all(a['notes']==b['notes'] for a,b in zip(rows_before,rows_after,strict=True) if (a['start'],a['end'])==(b['start'],b['end'])),
      'quietEndingsPreserved':all(x['previouslyCoveredPointsRetained'] for x in quiet_endings),
      'noPreviouslyPitchedTargetFrameLost':not removed_pitch_frames,
      'allCommonPitchedTargetFramesUnchangedWithin1eMinus9':not changed_existing_pitch_frames,
      'noPreviouslyActiveTargetFrameLost':not removed_activity_frames,
      'targetFramesIdenticalWithin1eMinus9':not frame_changes,
    }
    result={'label':args.label,'comparisonStatus':args.comparison_status,'limitations':['CREPE full model measurement, not human F0 or word-boundary ground truth.',('Prototype word payload comparison; rerun with final production output before claiming final verification.' if args.comparison_status=='prototype' else 'Final production cached-input word payload comparison; no fresh full-song ASR/MMS inference.'),('Uncertain emissions are paired with the related clean_entry waveform, not exact-source certified.' if 'uncertain' in before.get('case','') else 'Paired clean_entry waveform/scores provenance is exact; its ASR and CREPE values remain model observations, not manual word/pitch labels.')],
      'inputs':{'comparisonScriptSha256':digest_bytes(Path(__file__).read_bytes()),'beforeFile':str(args.before),'afterFile':str(args.after),'beforeSha256':digest_bytes(before_bytes),'afterSha256':digest_bytes(after_bytes),'pitchFile':str(args.pitch),'pitchSha256':digest_bytes(pitch_bytes),'algorithmsSha256':digest_bytes(Path(alg.__file__).read_bytes()),'sourceHashes':source_hashes,'beforeReplaySourceHashes':before.get('sourceHashes'),'afterReplaySourceHashes':after.get('sourceHashes'),'rawPoints':len(raw),'stabilizedPoints':len(stable),'stabilizedPitchSha256':digest_obj(stable_snapshot),'duration':duration,'beforeProvenance':before.get('case'),'afterProvenance':after.get('case')},
      'checks':checks,'globalMelodyNotes':[{'midiNote':n.note,'start':n.start,'end':n.end} for n in global_notes],
      'summary':{'beforeNoteCount':sum(len(w.notes) for w in docs[0].words),'afterNoteCount':sum(len(w.notes) for w in docs[1].words),'beforeContourPoints':len(maps[0]),'afterContourPoints':len(maps[1]),'ownershipChangedPoints':len(ownership),'targetFrameChanges':len(frame_changes),'addedPitchedTargetFrames':len(added_pitch_frames),'removedPitchedTargetFrames':len(removed_pitch_frames),'changedExistingPitchedTargetFrames':len(changed_existing_pitch_frames),'addedActiveTargetFrames':len(added_activity_frames),'removedActiveTargetFrames':len(removed_activity_frames),'quietThresholdRms':quiet_cut,'quietEndingWords':len(quiet_endings),'quietEndingWordsWithExistingCoverage':sum(bool(row['beforeCoveredPointTimes']) for row in quiet_endings),'quietEndingExistingPointsRetained':sum(len(row['beforeCoveredPointTimes']) for row in quiet_endings if row['previouslyCoveredPointsRetained'])},
      'focusBefore':[w for w in rows_before if w['index'] in [8,9,10]],'focusAfter':[w for w in rows_after if w['index'] in [8,9,10]],'ownershipChanges':ownership,
      'removedContourPoints':[maps[0][t] for t in sorted(maps[0].keys()-maps[1].keys())],'addedContourPoints':[maps[1][t] for t in sorted(maps[1].keys()-maps[0].keys())],
      'targetFrameChanges':frame_changes,'addedPitchedTargetFrames':added_pitch_frames,'removedPitchedTargetFrames':removed_pitch_frames,'changedExistingPitchedTargetFrames':changed_existing_pitch_frames,'addedActiveTargetFrames':added_activity_frames,'removedActiveTargetFrames':removed_activity_frames,'quietEndings':quiet_endings,'allWordsBefore':rows_before,'allWordsAfter':rows_after}
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps({'label':args.label,'checks':checks,'summary':result['summary'],'focusBefore':[{k:v for k,v in w.items() if k!='notes'} for w in result['focusBefore']],'focusAfter':[{k:v for k,v in w.items() if k!='notes'} for w in result['focusAfter']],'targetFrameChanges':frame_changes},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
