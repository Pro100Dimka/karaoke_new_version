from __future__ import annotations

import re
import unicodedata


def normalize_search(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


_CYRILLIC_TO_LATIN = str.maketrans(
    {
        "а": "a", "б": "b", "в": "v", "г": "g", "ґ": "g", "д": "d",
        "е": "e", "ё": "e", "є": "e", "ж": "zh", "з": "z", "и": "i",
        "і": "i", "ї": "i", "й": "i", "к": "k", "л": "l", "м": "m",
        "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t",
        "у": "u", "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh",
        "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
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
