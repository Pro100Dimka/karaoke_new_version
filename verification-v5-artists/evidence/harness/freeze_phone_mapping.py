"""Freeze conservative grapheme/phone groups from external labels only.

No prediction path is accepted. Equal counts alone never establish a mapping.
Silent signs and one-grapheme/multiple-phone cases remain explicitly excluded.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import unicodedata

PHONES = {
    "а": {"a", "ɐ", "ə", "æ"}, "о": {"o", "ɔ", "ɐ", "ə"},
    "у": {"u", "ʊ"}, "ы": {"ɨ", "ɪ"}, "и": {"i", "ɪ", "ɨ"},
    "э": {"e", "ɛ", "ɪ"}, "е": {"e", "ɛ", "ɪ", "ə"},
    "ё": {"o", "ɵ", "ɔ"}, "я": {"a", "ɐ", "ə"}, "ю": {"u", "ʊ"},
    "б": {"b", "p"}, "п": {"p"}, "в": {"v", "f"}, "ф": {"f"},
    "г": {"ɡ", "g", "k", "x"}, "к": {"k"}, "д": {"d", "t"},
    "т": {"t"}, "ж": {"ʐ", "ʒ", "ʂ"}, "ш": {"ʂ", "ʃ"},
    "з": {"z", "s"}, "с": {"s"}, "х": {"x", "ç"}, "ц": {"ts"},
    "ч": {"tɕ", "tʃ"}, "щ": {"ɕ", "ʃ"}, "м": {"m"},
    "н": {"n", "ɲ", "ŋ"}, "л": {"l", "ɫ"}, "р": {"r", "ɾ"}, "й": {"j"},
}


def normalized(phone):
    return "".join(c for c in unicodedata.normalize("NFD", phone)
                   if not unicodedata.combining(c) and c not in "ːˑʲʷˈˌ")


def groups_for(word):
    text, phones = word["text"].casefold(), word["phones"]
    if not word.get("phoneMetricEligible", False):
        return None, "reference_quality_flags: " + ", ".join(word.get("phoneQualityFlags", []))
    if any(c not in PHONES for c in text):
        return None, "silent_sign_punctuation_or_unsupported_grapheme"
    options = []

    def visit(char_index, phone_index, groups):
        if len(options) > 1:
            return
        if char_index == len(text) and phone_index == len(phones):
            options.append(groups)
            return
        if char_index == len(text) or phone_index == len(phones):
            return
        phone = phones[phone_index]
        if normalized(phone["text"]) not in PHONES[text[char_index]]:
            return
        widths = [1]
        if (char_index + 1 < len(text) and text[char_index] == text[char_index + 1]
                and text[char_index] not in "аоуыиэеёяю"):
            widths.append(2)
        for width in widths:
            visit(char_index + width, phone_index + 1, groups + [{
                "characters": text[char_index:char_index + width],
                "indices": list(range(char_index, char_index + width)),
                "reference": phone,
                "internalGrouping": "one grapheme per compatible phone" if width == 1
                    else "doubled consonant compared as one phone; no intra-group truth",
            }])

    visit(0, 0, [])
    if len(options) != 1:
        return None, "ambiguous_grapheme_phone_mapping" if options else "no_supported_grapheme_phone_mapping"
    return options[0], None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError("Do not overwrite frozen reference mapping")
    rows, excluded = [], []
    for case in json.loads(args.reference.read_text())["cases"]:
        for word in case["words"]:
            groups, reason = groups_for(word)
            row = {"case": case["case"], "wordIndex": word["index"], "word": word["text"]}
            if reason:
                excluded.append({**row, "reason": reason})
            else:
                rows.append({**row, "groups": groups})
    report = {
        "frozenAtUtc": datetime.now(timezone.utc).isoformat(),
        "referenceSha256": hashlib.sha256(args.reference.read_bytes()).hexdigest(),
        "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "method": "Conservative unique identity-compatible grapheme/phone grouping; labels only, no predictions. Phone quality flags are frozen upstream. Raw word metrics exclude no words.",
        "words": rows, "excludedWords": excluded,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"includedWords": len(rows), "excludedWords": len(excluded)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
