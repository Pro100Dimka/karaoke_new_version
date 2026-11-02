from __future__ import annotations

import re
import unicodedata

from num2words import num2words

_CHORD = re.compile(r"[A-H][#♯b♭]?(?:(?:maj|min|dim|aug|sus|add|m|M)?\d*)?(?:/[A-H][#♯b♭]?)?")


def normalize_search(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


def strip_catalog_credits(value: str) -> str:
    """Discard a catalogue's standalone source credit before alignment or cache reuse."""
    return "\n".join(
        line.strip()
        for line in value.splitlines()
        if line.strip()
        and not re.fullmatch(
            r"\s*(?:Взято с сайта|Взято із сайту)\s*:?(?:\s+https?://\S+)?\s*",
            line,
            re.IGNORECASE,
        )
    )


_CYRILLIC_TO_LATIN = str.maketrans(
    {
        "а": "a",
        "б": "b",
        "в": "v",
        "г": "g",
        "ґ": "g",
        "д": "d",
        "е": "e",
        "ё": "e",
        "є": "e",
        "ж": "zh",
        "з": "z",
        "и": "i",
        "і": "i",
        "ї": "i",
        "й": "i",
        "к": "k",
        "л": "l",
        "м": "m",
        "н": "n",
        "о": "o",
        "п": "p",
        "р": "r",
        "с": "s",
        "т": "t",
        "у": "u",
        "ф": "f",
        "х": "h",
        "ц": "ts",
        "ч": "ch",
        "ш": "sh",
        "щ": "shch",
        "ъ": "",
        "ы": "y",
        "ь": "",
        "э": "e",
        "ю": "yu",
        "я": "ya",
    }
)


def normalize_catalog_identity(value: str) -> str:
    """Normalizes Cyrillic, Ukrainian and Latin catalog spellings to one searchable identity."""
    transliterated = normalize_search(value).translate(_CYRILLIC_TO_LATIN)
    return "".join(character for character in transliterated if character.isalnum())


def strip_annotations(value: str) -> str:
    """Drops bracketed parts such as "(zaycev.net)" or "[Live]" and collapses the whitespace that remains."""
    return " ".join(re.sub(r"[\(\[].*?[\)\]]", " ", value).split())


def spell_lyric_percentages(text: str, language: str) -> str:
    """Give the aligner letters to pronounce when a catalogue writes a sung percentage as digits."""
    locale, forms = {
        "Ukrainian": ("uk", ("відсоток", "відсотки", "відсотків")),
        "Russian": ("ru", ("процент", "процента", "процентов")),
        "English": ("en", ("percent", "percent", "percent")),
    }.get(language, ("en", ("percent", "percent", "percent")))

    def replace(match: re.Match[str]) -> str:
        value = int(match[1])
        form = 2 if 11 <= value % 100 <= 14 else {1: 0, 2: 1, 3: 1, 4: 1}.get(value % 10, 2)
        try:
            return f"{num2words(value, lang=locale)} {forms[form]}"
        except (OverflowError, ValueError):
            return match[0]

    return re.sub(r"(?<![\w.,])(\d+)\s*%", replace, text)


def clean_lyrics(text: str, language: str) -> str:
    """Normalize found lyrics before recognition matching or alignment, retaining written lines."""
    text = spell_lyric_percentages(_without_chord_rows(text), language)
    text = "".join(
        "" if char in "'’ʼ`" else " " if unicodedata.category(char)[0] in "PS" else char
        for char in text
    )
    return "\n".join(" ".join(line.split()) for line in text.splitlines() if line.strip())


def _without_chord_rows(text: str) -> str:
    """Discard repeated chord-chart rows in Cyrillic lyrics, retaining ambiguous prose."""
    if not re.search(r"[А-Яа-яЁёІіЇїЄєҐґ]", text):
        return text
    lines = text.splitlines()
    rows: dict[int, list[str]] = {}
    for index, line in enumerate(lines):
        tokens = line.split()
        chords = [token for token in tokens if _CHORD.fullmatch(token)]
        if not chords or any(
            token not in ["I", "II", "III", "|", "||", ":"]
            for token in tokens
            if not _CHORD.fullmatch(token)
        ):
            continue
        # A solitary chord followed by a roman marker may instead be "Am I".
        if len(chords) < 2 and len(chords) != len(tokens):
            continue
        rows[index] = chords
    modified = {chord for chords in rows.values() for chord in chords if len(chord) > 1}
    if len(rows) < 2 or len(modified) < 2:
        return text
    return "\n".join(line for index, line in enumerate(lines) if index not in rows)
