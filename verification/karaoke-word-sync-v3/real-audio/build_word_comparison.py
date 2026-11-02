"""Evidence table. Model output differences are never labelled acoustic errors.

Optional final replays come from the same cached-input harnesses as the v2 evidence.
This script does not run models or modify product/source/audio files.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import re

import numpy as np


def read(path: Path):
    return json.loads(path.read_text())


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def norm(text: str) -> str:
    return re.sub(r"[^\w]", "", text.casefold())


def retained(word):
    return {
        "start": word["start"],
        "end": word["end"],
        "durationMs": round(1000 * (word["end"] - word["start"]), 3),
        "letters": word["letters"],
        "letterIntervalsMs": [
            round(1000 * (b - a), 3)
            for a, b in zip(word["letters"], [*word["letters"][1:], word["end"]])
        ],
        "confidence": word.get("confidence", word.get("score")),
        "diagnostics": word.get("diagnostics", []),
    }


def make_row(source, index, v1, v2, final, heard=(), observations=()):
    asr = [
        {"text": t, "start": s, "end": e}
        for t, s, e in heard
        if norm(t) == norm(v2["text"])
    ]
    return {
        "source": source,
        "wordIndex": index,
        "text": v2["text"],
        "reference": {
            "start": None,
            "end": None,
            "listened": False,
            "humanCertified": False,
            "reason": "No independent manually adjudicated word boundaries for this waveform.",
        },
        "v1": retained(v1),
        "v2": retained(v2),
        "final": retained(final) if final is not None else None,
        "errorsMs": {
            key: {"start": None, "end": None}
            for key in ("v1", "v2", "final")
        },
        "v1ToV2ChangeMs": {
            "start": round((v2["start"] - v1["start"]) * 1000, 3),
            "end": round((v2["end"] - v1["end"]) * 1000, 3),
        },
        "v2ToFinalChangeMs": {
            "start": round((final["start"] - v2["start"]) * 1000, 3),
            "end": round((final["end"] - v2["end"]) * 1000, 3),
        } if final is not None else None,
        "independentAsrObservations": asr,
        "asrIsGroundTruth": False,
        "observations": list(observations),
    }


def interval(word):
    return "—" if word is None else f"{word['start']:.3f}–{word['end']:.3f}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--final-clean", type=Path)
    parser.add_argument("--final-performance", type=Path)
    parser.add_argument("--final-sadvit", type=Path)
    args = parser.parse_args()
    e = args.evidence
    inputs = {
        "v1Clean": e / "odin/baseline-v1-clean-paired.json",
        "v2Clean": e / "odin/production-clean-paired.json",
        "v1Performance": e / "performance/v1.json",
        "v2Performance": e / "performance/final.json",
        "v1SadSvit": e / "real-audio/sadvit-baseline-v1.json",
        "v2SadSvit": e / "real-audio/sadvit-current-final.json",
    }
    v1c, v2c = read(inputs["v1Clean"]), read(inputs["v2Clean"])
    v1p, v2p = read(inputs["v1Performance"]), read(inputs["v2Performance"])
    v1s, v2s = read(inputs["v1SadSvit"]), read(inputs["v2SadSvit"])
    final_clean = read(args.final_clean) if args.final_clean else None
    final_performance = read(args.final_performance) if args.final_performance else None
    final_sadvit = read(args.final_sadvit) if args.final_sadvit else None
    for key, path in (
        ("finalClean", args.final_clean),
        ("finalPerformance", args.final_performance),
        ("finalSadSvit", args.final_sadvit),
    ):
        if path:
            inputs[key] = path
    fixture = args.repo / "python/tests/fixtures/wildways-verse-entry.npz"
    with np.load(fixture) as f:
        clean_meta = json.loads(str(f["clean_entry_metadata"]))
        reply_meta = json.loads(str(f["reply_metadata"]))
    sources = {
        "clean_entry": {
            "song": "Wildways fixture (full source title not retained)",
            "language": "Russian",
            "timebase": "seconds from the 17-second stored excerpt start",
            "waveformAndScoresPaired": True,
            "inputs": v2c["inputs"],
            "freshAiInference": False,
            "scope": "speech.align using retained real CTC/ASR and actual waveform postprocessing",
        },
        "reply": {
            "song": "Wildways fixture (full source title not retained)",
            "language": "Russian",
            "timebase": "seconds from the 40-second stored excerpt start; original offset110s",
            "waveformAndScoresPaired": True,
            "inputs": next(c["inputs"] for c in v2p["cases"] if c["case"] == "reply"),
            "freshAiInference": False,
            "scope": "speech.align with cached CTC/independent ASR/singing mask; no additional local ASR output available",
        },
        "sadvit": {
            "song": "SadSvit — Небо",
            "language": "Ukrainian",
            "timebase": "absolute seconds in source song",
            "freshAiInference": False,
            "scope": "phrase ends: with_sung_ends from retained cores; outro: align_words + with_sung_ends",
        },
    }
    rows = []
    for i, (before, current) in enumerate(zip(v1c["payload"]["words"], v2c["payload"]["words"])):
        final = final_clean["payload"]["words"][i] if final_clean else None
        observations = []
        if current["confidence"] == 0:
            observations.append("Approximate letters retained with zero confidence; timings are not phoneme measurements.")
        if i == 9:
            observations.append("Exact paired Odin control: initial seam not independently labelled; i occupies20ms and n540ms in v2.")
        if i == 8:
            observations.append("Neighbour of Odin; ordered removes100ms after onset adjustment, but no independent seam reference proves this wrong.")
        rows.append(make_row("clean_entry", i, before, current, final, clean_meta["heard"], observations))
    before_reply = next(c for c in v1p["cases"] if c["case"] == "reply")
    current_reply = next(c for c in v2p["cases"] if c["case"] == "reply")
    final_reply = next(c for c in final_performance["cases"] if c["case"] == "reply") if final_performance else None
    for i in (4, 5, 11, 12, 13, 15, 16, 22, 23, 24, 25, 27):
        before, current = before_reply["finalPayload"]["words"][i], current_reply["finalPayload"]["words"][i]
        final = final_reply["finalPayload"]["words"][i] if final_reply else None
        observations = []
        if i in (12, 23):
            observations.append("Repeated word, independently retained performance duration; no forced duration equality.")
            observations.append("Final soft sign has no CTC token but frontend v2 gives it a separate progress interval.")
        if i == 24:
            observations.append("40ms word preserved; short duration alone does not prove an error.")
        if i == 16:
            observations.append("20ms v1→v2 earlier start from bounded review; not a certified20ms acoustic accuracy gain.")
        rows.append(make_row("reply", i, before, current, final, reply_meta["heard"], observations))
    for before, current in zip(v1s["cases"], v2s["cases"]):
        def word(case):
            return {"text": case["text"], **case["finalAbsolute"], "confidence": case["final"]["score"], "diagnostics": case["final"]["diagnostics"]}
        final_case = next(c for c in final_sadvit["cases"] if c["case"] == current["case"]) if final_sadvit else None
        row = make_row("sadvit", current["case"], word(before), word(current), word(final_case) if final_case else None)
        row["legacyAcousticEndBracket"] = current["endReferenceInterval"]
        row["legacyAcousticBracketIsCertifiedWordBoundary"] = False
        row["legacyEndBracketDistanceMs"] = {
            "v1": before["finalEndVsAcousticInterval"]["signedDistanceToIntervalMs"],
            "v2": current["finalEndVsAcousticInterval"]["signedDistanceToIntervalMs"],
            "final": final_case["finalEndVsAcousticInterval"]["signedDistanceToIntervalMs"] if final_case else None,
        }
        row["observations"] = ["Original metadata listened:false. Legacy acoustic bracket is not sufficient for an exact vocal endpoint/error claim."]
        rows.append(row)
    result = {
        "scope": "Factual retained real-excerpt outputs, with explicit absence of word-boundary ground truth.",
        "notAllRowsAreConfirmedErrors": True,
        "inputs": {k: {"path": str(p), "sha256": digest(p)} for k, p in inputs.items()},
        "sourceInformation": sources,
        "rows": rows,
        "metrics": {
            "wordRows": len(rows), "certifiedStartReferences": 0, "certifiedEndReferences": 0,
            "medianAbsoluteStartErrorMs": None, "maximumAbsoluteStartErrorMs": None,
            "medianAbsoluteEndErrorMs": None, "maximumAbsoluteEndErrorMs": None,
            "reason": "These metrics require independent word-boundary references; none are supplied. Model agreement and word movement are different quantities.",
        },
        "missingMaterials": [
            "Exact source audio that produced uncertain_scores, and its preprocessing/hash/offset, to validate9.10s rather than the related recording variant.",
            "Complete Russian and Ukrainian source/reference-vocal/instrumental files for the failing user projects, with original lyricsSync.json and processing report.",
            "Independent listened/adjudicated start/end labels for the suspect words and neighbours, with an uncertainty interval for fused transitions.",
            "For held-vowel/consonant accuracy: independent phoneme or letter-group labels on the same waveform; ASR and CTC cannot serve as their own ground truth.",
            "Real project playback on the target Electron/Windows system to verify visible line/letter transitions against the unchanged recording.",
        ],
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "real-word-comparison.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    text = [
        "ФАКТИЧЕСКИЕ СЛОВА ИЗ СОХРАНЁННЫХ РЕАЛЬНЫХ ФРАГМЕНТОВ",
        "Числа v1/v2/final — результаты алгоритма, не независимая акустическая разметка.",
        "Все реальные start/end и ошибки в мс: н/д. Прослушивание в этой проверке не выполнено.",
        "Некоторые строки — контрольные интервалы; все строки не объявляются ошибочными.",
        "clean_entry/reply — секунды фрагмента; SadSvit — секунды исходной песни.",
        "",
        "| Фрагмент / индекс | Слово | Реальное время | v1 | v2 | Финальная версия | Ошибка start/end, мс |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        text.append(f"| {r['source']} / {r['wordIndex']} | {r['text']} | н/д | {interval(r['v1'])} | {interval(r['v2'])} | {interval(r['final'])} | н/д / н/д |")
    text.extend(["", "Медианная и максимальная ошибка: не вычисляются без независимого эталона.", "", "Необходимые материалы:", *["- " + s for s in result["missingMaterials"]]])
    (args.output / "real-word-comparison.txt").write_text("\n".join(text) + "\n")
    print(json.dumps({"rows": len(rows), "finalRows": sum(r["final"] is not None for r in rows), "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
