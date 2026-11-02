"""Replay the real cached MMS candidate choice without loading an AI model.

This verifies retention of CTC letter anchors, not the true onset of the word.
Pass the exported pivovarov_dezhavyu_ua.npz from ctc-evidence.
"""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo-python', type=Path, required=True)
parser.add_argument('--features', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
sys.path.insert(0,str(args.repo_python))
import numpy as np
import torch
from backend.ai_worker import ctc, word_guidance

torch.set_num_threads(1)
with np.load(args.features) as features:
    scores=torch.from_numpy(features['scores'])
    step=float(features['frame_seconds'])
    active=features['voiced_frames']
    onsets=features['vocal_onsets'].tolist()
window=ctc.Window(0,2,0.0,3.0)
original=ctc._align_window(scores,step,['Хвилями,','хвилями,'],window)
candidates=word_guidance._candidates(original[0],scores,step,window,(.56,1.32),active,.6,onsets)
chosen=word_guidance._select_sequence(original,[[original[0],*candidates],[original[1]]],{0:(.56,1.32)},0,active)
output={
 'scope':'Real cached MMS and activity, no AI inference. No true word onset asserted.',
 'featuresSha256':hashlib.sha256(args.features.read_bytes()).hexdigest(),
 'guidanceSourceSha256':hashlib.sha256(Path(word_guidance.__file__).read_bytes()).hexdigest(),
 'modelCalls':0,'original':[asdict(w) for w in original],
 'candidates':[asdict(w) for w in candidates],'selected':[asdict(w) for w in chosen],
 'positiveConfidence':chosen[0].score>0,
 'acousticSuffixRetained':chosen[0].letters[1:]==original[0].letters[1:],
 'followingUnchanged':chosen[1]==original[1], 'trueOnsetVerified':False,
}
args.output.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:output[k] for k in ('positiveConfidence','acousticSuffixRetained','followingUnchanged','trueOnsetVerified')}))
