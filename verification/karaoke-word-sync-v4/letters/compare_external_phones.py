from __future__ import annotations
from pathlib import Path
from statistics import median
import argparse,hashlib,json
p=argparse.ArgumentParser();p.add_argument("--prediction-dir",type=Path,required=True);p.add_argument("--output",type=Path,required=True);p.add_argument("--label",required=True);a=p.parse_args()
frozen=Path("/tmp/karaoke-sync-v4/letters/frozen-phone-mapping.json")
mapping=json.loads(frozen.read_text());rows=[];absent=[];inputs=[]
for word in mapping["words"]:
    source=a.prediction_dir/word["case"]/"payload.json"
    if not source.exists():
        absent.append(word["case"]);continue
    data=json.loads(source.read_text());pred=data["words"][word["wordIndex"]]
    assert pred["text"].casefold()==word["word"].casefold()
    inputs.append({"path":str(source),"sha256":hashlib.sha256(source.read_bytes()).hexdigest()})
    groups=word["groups"]
    for i,g in enumerate(groups):
        start=pred["letters"][g["indices"][0]]
        end=pred["letters"][groups[i+1]["indices"][0]] if i+1<len(groups) else pred["end"]
        rows.append({"case":word["case"],"wordIndex":word["wordIndex"],"word":word["word"],"characters":g["characters"],"indices":g["indices"],"phone":g["reference"]["text"],"referenceStart":g["reference"]["start"],"referenceEnd":g["reference"]["end"],"predictedStart":start,"predictedEnd":end,"startErrorMs":round(1000*(start-g["reference"]["start"]),3),"endErrorMs":round(1000*(end-g["reference"]["end"]),3),"internalStart":i>0,"startDiagnostics":pred["diagnostics"]})
internal=[r for r in rows if r["internalStart"]]
summary={"wordCount":len(set((r["case"],r["wordIndex"]) for r in rows)),"phonemeGroupCount":len(rows),"internalBoundaryCount":len(internal),"internalStartMedianAbsErrorMs":median(abs(r["startErrorMs"]) for r in internal) if internal else None,"internalStartMaxAbsErrorMs":max((abs(r["startErrorMs"]) for r in internal),default=None)}
report={"label":a.label,"mappingSha256":hashlib.sha256(frozen.read_bytes()).hexdigest(),"referenceDescription":"External GTSinger authors listening/spectrogram-corrected labels, fixed before model predictions. PhoneMetricEligible excludes detected uniform/suspect reference labels. Doubled нн compared as one nasal group, not two independently marked phones. Published annotation uncertainty is unspecified.","payloads":list({v["path"]:v for v in inputs}.values()),"missingCases":sorted(set(absent)),"summary":summary,"rows":rows}
a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(summary))
for row in sorted(internal,key=lambda r:abs(r["startErrorMs"]),reverse=True)[:10]:
    print(row["case"],row["word"],row["characters"],row["startErrorMs"])
