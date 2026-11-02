from __future__ import annotations
import argparse,sys,json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--repo',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();sys.path.insert(0,str(a.repo/'python'))
import numpy as np,torch
from backend.ai_worker import ctc
from torchaudio.functional import forced_align,merge_tokens

with np.load(a.repo/'python/tests/fixtures/wildways-verse-entry.npz') as f:scores=torch.from_numpy(f['uncertain_scores'])
labels={v:k for k,v in ctc.MMS_FA.get_dict(star=None).items()}
def path(words,begin,end,*,bounded_end=False):
    i,j=round(begin/.02),round(end/.02);s=scores[i:j]
    owners=[];tokens=[]
    for wi,word in enumerate(words):
        for ci,parts in enumerate(ctc._character_tokens(word,' '.join(words))):
            for token in parts:
                tokens.append(token);owners.append((wi,ci,word))
    if not bounded_end:
        star=s.shape[1];s=torch.cat((s,s.new_zeros((len(s),1))),dim=1);tokens.append(star)
    aligned,prob=forced_align(s[None],torch.tensor([tokens],dtype=torch.int32),blank=0)
    spans=merge_tokens(aligned[0],prob[0].exp());rows=[]
    for span,(wi,ci,word) in zip(spans,owners):
        rows.append({'word':word,'wordIndex':wi,'characterIndex':ci,'token':labels[span.token],'start':round((i+span.start)*.02,3),'end':round((i+span.end)*.02,3),'meanProbability':span.score})
    out={'window':[i*.02,j*.02],'words':words,'boundedEnd':bounded_end,'logLikelihood':float(prob[0].sum()),'tokenRows':rows,'wordsAligned':[{'text':w.text,'start':w.start,'end':w.end,'letters':w.letters,'score':w.score} for w in ctc.align_words(scores[i:j],.02,words,i*.02,bounded_end=bounded_end)]}
    return out
base=path(['я','один','23','этаж,'],7.96,11.84)
report={'source':'uncertain_scores','labels':labels,'unconstrained':base,'seams':[]}
for boundary,source in [(9.98,'independent next-phrase CTC first23 core'),(10.04,'uncertain recognized word end'),(9.76,'existing clean_entry recognized next23 boundary9.75 rounded to frame')]:
    left=path(['я','один'],7.96,boundary,bounded_end=True)
    right=path(['23','этаж,'],boundary,11.84)
    loss=base['logLikelihood']-left['logLikelihood']-right['logLikelihood']
    report['seams'].append({'boundary':boundary,'source':source,'left':left,'right':right,'logLikelihoodLossVsJointUnconstrained':loss})
for text,start,end in [('один',9.1,10.04),('один',9.1,9.98),('один',9.1,9.76)]:
    report.setdefault('singleWordBoundaries',[]).append(path([text],start,end,bounded_end=True))
pieces = [
    path(['я'], 7.96, 9.1, bounded_end=True),
    path(['один'], 9.1, 9.98, bounded_end=True),
    path(['23', 'этаж,'], 9.98, 11.84),
]
report['jointWithBothAnchors'] = {
    'boundsSource': 'uncertain preceding recognized я end9.1 + independent following CTC23 start9.98',
    'pieces': pieces,
    'logLikelihoodLossVsUnconstrained': base['logLikelihood'] - sum(x['logLikelihood'] for x in pieces),
}
a.out.write_text(json.dumps(report,ensure_ascii=False,indent=2))
print('unconstrained',base['logLikelihood'],base['wordsAligned'])
for r in report['seams']:
    print('seam',r['boundary'],'loss',r['logLikelihoodLossVsJointUnconstrained'])
    print(r['left']['wordsAligned'],r['right']['wordsAligned'])
print('token owners9-10.5')
for name,rows in [('unconstrained',base['tokenRows']),('seam9.98',report['seams'][0]['left']['tokenRows']+report['seams'][0]['right']['tokenRows'])]:
 print(name)
 for r in rows:
    if r['end']>=9 and r['start']<=10.5:print(r)
