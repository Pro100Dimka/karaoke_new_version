from pathlib import Path
from urllib.request import urlopen
from urllib.parse import quote
import json,hashlib,re
from datetime import datetime,timezone
root=Path(__file__).parent
rule={
 'createdAtUtc':datetime.now(timezone.utc).isoformat(),
 'rule':'Additional diagnostic set, does not replace the first24-word holdout. Enumerate Control_Group of the same first Russian Breathy song in ascending numeric index, excluding previously selected0000/0001. Select first two clips having at least two words with pronounced final consonant spelling; inspect external annotation only, no prediction. Final consonant regex [бвгджзйклмнпрстфхцчшщ][ьъ]?$; verifies a final consonant phoneme in published label. If insufficient, extend to next song in directory order. No preferred model outcome.',
 'selectionUsesModelOutput':False,
}
(root/'additional-selection-rule.json').write_text(json.dumps(rule,ensure_ascii=False,indent=2))
rev=json.loads((root/'upstream-revision.json').read_text())['sha']
paths=json.loads((root/'additional-candidate-paths.json').read_text())
candidates=[];selected=[];downloads=[]
for path in paths:
 if Path(path).stem in ['0000','0001']:continue
 url='https://huggingface.co/datasets/GTSinger/GTSinger/resolve/'+rev+'/'+quote(path)
 with urlopen(url,timeout=30) as f:raw=f.read()
 local=root/'gtsinger'/Path(path).relative_to('Russian/RU-Alto-1/Breathy');local.parent.mkdir(parents=True,exist_ok=True);local.write_bytes(raw)
 d=json.loads(raw)
 final=[w for w in d if not w['word'].startswith('<') and re.search(r'[бвгджзйклмнпрстфхцчшщ][ьъ]?$',w['word'])]
 eligible=[w for w in final if w['ph'][-1] not in ['a','ə','e','ɐ','ɨ','ɪ','i','o','u','æ','ɛ','ɔ','ʊ']]
 candidates.append({'path':path,'wordCount':len([w for w in d if not w['word'].startswith('<')]),'finalConsonantWords':[{'word':w['word'],'phone':w['ph'][-1],'duration':w['ph_end'][-1]-w['ph_start'][-1]} for w in eligible]})
 downloads.append({'relativePath':str(local.relative_to(root/'gtsinger')),'url':url,'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
 print(Path(path).stem,[w['word'] for w in eligible],flush=True)
 if len(eligible)>=2:selected.append(path)
 if len(selected)==2:break
assert len(selected)==2
(root/'additional-selected-candidates.json').write_text(json.dumps({'rule':rule,'inspected':candidates,'selected':selected,'downloads':downloads},ensure_ascii=False,indent=2))
print('selected',selected,flush=True)
for path in selected:
 for ext in ['wav','TextGrid']:
  p=str(Path(path).with_suffix('.'+ext));url='https://huggingface.co/datasets/GTSinger/GTSinger/resolve/'+rev+'/'+quote(p)
  with urlopen(url,timeout=30) as f:raw=f.read()
  local=root/'gtsinger'/Path(p).relative_to('Russian/RU-Alto-1/Breathy');local.write_bytes(raw)
  downloads.append({'relativePath':str(local.relative_to(root/'gtsinger')),'url':url,'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
(root/'additional-download-manifest.json').write_text(json.dumps(downloads,ensure_ascii=False,indent=2))
